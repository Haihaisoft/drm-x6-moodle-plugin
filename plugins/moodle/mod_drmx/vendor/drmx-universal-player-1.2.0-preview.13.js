(function installDrmXUniversalPlayer(global) {
  "use strict";

  const SDK_VERSION = "1.2.0-preview.13";
  const CONTRACT_VERSION = 1;
  const WISEPLAY_AUTOMATIC_MAXIMUM_HEIGHT = 576;
  const MAXIMUM_WISEPLAY_MANIFEST_BYTES = 2_000_000;
  const PLAYREADY_STARTUP_MAXIMUM_HEIGHT = 576;
  const PLAYREADY_SOFTWARE_MAXIMUM_HEIGHT = 1200;
  const PLAYREADY_STARTUP_TIMEOUT_MS = 6_000;
  const WIDEVINE_ANDROID_STARTUP_MAXIMUM_HEIGHT = 576;
  const STARTUP_PROMOTION_SECONDS = 1;
  const keySystems = Object.freeze({
    widevine: ["com.widevine.alpha"],
    playready: [
      "com.microsoft.playready.recommendation",
      "com.microsoft.playready",
      "com.microsoft.playready.recommendation.3000",
    ],
    fairplay: ["com.apple.fps", "com.apple.fps.1_0"],
    wiseplay: ["com.huawei.wiseplay"],
  });
  const baseKeySystems = Object.freeze({
    widevine: "com.widevine.alpha",
    playready: "com.microsoft.playready",
    fairplay: "com.apple.fps",
    wiseplay: "com.huawei.wiseplay",
  });
  const active = new WeakMap();
  const operations = new WeakMap();
  const disposals = new WeakMap();
  const liveVideos = new Set();
  const reportingDeviceId = global.crypto?.randomUUID?.()
    || `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;

  function emit(target, name, detail) {
    if (typeof target?.dispatchEvent !== "function" || typeof global.CustomEvent !== "function") return;
    target.dispatchEvent(new global.CustomEvent(name, { detail }));
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function attemptId() {
    return global.crypto?.randomUUID?.()
      || `attempt-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function safeDiagnosticValue(value, depth = 0, key = "") {
    if (/token|authorization|secret|credential|license.*url|certificate.*url|manifest.*url|key.?id|kid/i.test(key)) {
      return "[redacted]";
    }
    if (depth > 4) return "[depth-limited]";
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      return value.slice(0, 300)
        .replace(/https?:\/\/[^\s"']+/gi, "[url-redacted]")
        .replace(/[\u0000-\u001f\u007f]/g, " ");
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeDiagnosticValue(item, depth + 1, key));
    if (typeof value !== "object") return "[unsupported]";
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
      result[String(childKey).slice(0, 80)] = safeDiagnosticValue(childValue, depth + 1, childKey);
    }
    return result;
  }

  function errorDetails(error) {
    return safeDiagnosticValue({
      name: error?.name || "Error",
      message: error?.message || "Playback failed.",
      code: error?.code ?? null,
      category: error?.category ?? null,
      severity: error?.severity ?? null,
      data: Array.isArray(error?.data) ? error.data.slice(0, 6) : null,
    });
  }

  function diagnosticContains(value, expected, depth = 0, seen = new Set()) {
    if (typeof value === "string") return value.includes(expected);
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return false;
    seen.add(value);
    for (const child of Array.isArray(value)
      ? value.slice(0, 20)
      : Object.values(value).slice(0, 20)) {
      if (diagnosticContains(child, expected, depth + 1, seen)) return true;
    }
    return false;
  }

  function isWidevineSessionAuthenticationFailure(error) {
    return Number(error?.code) === 6007
      && diagnosticContains(error?.data, "session_authentication_failed");
  }

  function widevineAuthenticationError() {
    const error = new Error(
      "This device's Widevine CDM could not authenticate after one fresh-session retry. "
      + "Update Chrome and Android System WebView, allow protected content, and verify that the device can reach Widevine provisioning services.",
    );
    error.code = "widevine_cdm_authentication_failed";
    return error;
  }

  function networkRetryParameters(maxAttempts) {
    return {
      maxAttempts,
      baseDelay: 500,
      backoffFactor: 2,
      fuzzFactor: 0.5,
      timeout: 30_000,
      stallTimeout: 15_000,
      connectionTimeout: 12_000,
    };
  }

  function scheduleLogFlush(operation) {
    if (!operation?.logEndpoint || operation.logTimer || typeof global.setTimeout !== "function") return;
    operation.logTimer = global.setTimeout(() => {
      operation.logTimer = null;
      void flushLogs(operation, false);
    }, 500);
  }

  function withDeadline(promise, timeoutMs, code, message, signal, onTimeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        signal?.removeEventListener?.("abort", abort);
        handler(value);
      };
      const abort = () => finish(reject, playbackReplacedError());
      const timer = global.setTimeout(() => {
        const error = new Error(message);
        error.code = code;
        finish(reject, error);
        onTimeout?.();
      }, timeoutMs);
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      signal?.addEventListener?.("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function startupStage(promise, operation, timeoutMs, code, message) {
    return withDeadline(promise, timeoutMs, code, message, operation.controller.signal,
      () => operation.controller.abort());
  }

  function assertCurrentOperation(operation) {
    if (operation.controller.signal.aborted || operations.get(operation.video) !== operation) {
      throw playbackReplacedError();
    }
  }

  async function boundedFetch(url, init, timeoutMs) {
    const controller = new global.AbortController();
    return withDeadline(global.fetch(url, { ...init, signal: controller.signal }), timeoutMs,
      "request_timeout", "The request timed out.", null, () => controller.abort());
  }

  async function flushLogs(operation, keepalive) {
    if (!operation?.logEndpoint || !operation.logQueue?.length) return;
    const events = operation.logQueue.splice(0, 20);
    try {
      await boundedFetch(operation.logEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        keepalive: Boolean(keepalive),
        body: JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          sdkVersion: SDK_VERSION,
          contentId: operation.contentId,
          attemptId: operation.attemptId,
          events,
        }),
      }, 5_000);
    } catch {
      // Diagnostics are best effort and never block protected playback.
    }
    if (operation.logQueue.length) scheduleLogFlush(operation);
  }

  function report(operation, phase, details = {}, severity = "info") {
    if (!operation) return;
    const event = {
      timestamp: new Date().toISOString(),
      phase,
      severity,
      details: safeDiagnosticValue(details),
    };
    emit(operation.video, "drmxlog", event);
    if (operations.get(operation.video) === operation) emit(operation.video, "drmxprogress", { phase });
    if (!operation.logEndpoint) return;
    operation.logQueue ??= [];
    operation.logQueue.push(event);
    if (operation.logQueue.length >= 10) void flushLogs(operation, false);
    else scheduleLogFlush(operation);
  }

  function platformIdentity() {
    const navigator = global.navigator || {};
    return `${navigator.userAgent || ""} ${navigator.platform || ""} ${navigator.userAgentData?.platform || ""}`;
  }

  function isAppleMobileBrowser() {
    const navigator = global.navigator || {};
    const agent = platformIdentity();
    return /iPhone|iPad|iPod/i.test(agent)
      || (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1);
  }

  function isTouchArmBrowser() {
    const navigator = global.navigator || {};
    const identity = platformIdentity();
    return Number(navigator.maxTouchPoints || 0) > 0
      && (/arm|aarch64/i.test(identity) || /Android|HarmonyOS|OpenHarmony/i.test(identity));
  }

  function preferredDrm() {
    const agent = platformIdentity();
    const safari = /AppleWebKit/i.test(agent) && /Safari/i.test(agent)
      && !/(Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|OPiOS)/i.test(agent);
    if (isAppleMobileBrowser() || safari) return "fairplay";
    if (/(HUAWEI|HONOR|HarmonyOS|OpenHarmony)/i.test(agent) || isTouchArmBrowser()) return "wiseplay";
    if (/Windows/i.test(agent) && /Edg\//i.test(agent)) return "playready";
    return "widevine";
  }

  function orderedDrms(requested) {
    if (requested && requested !== "auto") {
      if (!hasOwn(keySystems, requested)) throw new Error("Unsupported DRM selection.");
      return [requested];
    }
    const preferred = preferredDrm();
    if (preferred === "playready" || preferred === "wiseplay") return [preferred, "widevine"];
    return [preferred];
  }

  function prepareNativeFairPlay(requested, operation) {
    if (orderedDrms(requested)[0] !== "fairplay"
        || typeof global.WebKitMediaKeys !== "function"
        || typeof global.shaka?.polyfill?.PatchedMediaKeysApple?.install !== "function") return;
    // Safari can reject native HLS immediately after its modern SKD event,
    // before producing an SPC (also intermittent on macOS). Use Shaka's
    // supported Apple Media Keys integration for
    // every FairPlay session on this page, including VOD, so playlist changes
    // never switch the document-wide EME implementation under active players.
    if (global.shakaMediaKeysPolyfill !== "apple") {
      global.shaka.polyfill.PatchedMediaKeysApple.install();
    }
    report(operation, "fairplay.apple-media-keys", { playbackPath: "fairplay-native-hls" });
  }

  function canUseFairPlayMse(session) {
    return session.contentType !== "live" && global.shakaMediaKeysPolyfill !== "apple";
  }

  function mediaKeyConfiguration(drmSystem) {
    const fairPlay = drmSystem === "fairplay";
    const encryptionCapability = fairPlay ? {} : { encryptionScheme: "cenc" };
    // Keep the reusable SDK's EME probe identical to the proven Universal
    // Player path. Several Huawei Browser builds expose WisePlay but reject a
    // High-Profile-only AVC probe before Shaka can inspect the real manifest.
    // Baseline AVC is the broad compatibility capability; the manifest and
    // decoder still make the authoritative codec decision during player.load.
    const videoContentType = drmSystem === "playready"
      ? 'video/mp4; codecs="avc1.640032"'
      : 'video/mp4; codecs="avc1.42E01E"';
    return [{
      initDataTypes: fairPlay ? ["sinf", "skd"] : ["cenc"],
      distinctiveIdentifier: "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', ...encryptionCapability }],
      videoCapabilities: [{ contentType: videoContentType, ...encryptionCapability }],
    }];
  }

  async function selectDrm(requested = "auto", operation = null) {
    if (typeof global.navigator?.requestMediaKeySystemAccess !== "function") {
      throw new Error("This browser does not expose Encrypted Media Extensions.");
    }
    for (const drmSystem of orderedDrms(requested)) {
      for (const keySystem of keySystems[drmSystem]) {
        if (operation?.controller.signal.aborted) throw playbackReplacedError();
        report(operation, "drm.probe", { drmSystem, keySystem });
        try {
          const access = await global.navigator.requestMediaKeySystemAccess(
            keySystem,
            mediaKeyConfiguration(drmSystem),
          );
          report(operation, "drm.selected", { drmSystem, keySystem });
          return { drmSystem, keySystem, configuration: access.getConfiguration?.() || null };
        } catch (error) {
          if (operation?.controller.signal.aborted) throw playbackReplacedError();
          report(operation, "drm.probe-rejected", {
            drmSystem,
            keySystem,
            errorName: error?.name || "NotSupportedError",
          }, "debug");
        }
      }
    }
    throw new Error("No supported DRM key system was found on this browser and device.");
  }

  function platformCapabilities(selection) {
    const maximumHeight = Math.min(
      4320,
      Math.max(144, Math.round((global.screen?.height || 1080) * (global.devicePixelRatio || 1))),
    );
    return {
      clientPlatform: "web",
      drmSystems: [selection.drmSystem],
      manifestTypes: [selection.drmSystem === "fairplay" ? "hls" : "dash"],
      maximumHeight,
      secureDecoder: null,
      persistentState: false,
      sdkVersion: SDK_VERSION,
    };
  }

  function wisePlayCanonicalInitData(manifest) {
    const systemId = "3d5e6d359b9a41e8b843dd3c6e72c42c";
    const protectionPattern = /<(?:[A-Za-z_][\w.-]*:)?ContentProtection\b[^>]*schemeIdUri\s*=\s*["'][^"']*3d5e6d35-9b9a-41e8-b843-dd3c6e72c42c[^"']*["'][^>]*>[\s\S]*?<(?:[A-Za-z_][\w.-]*:)?pssh\b[^>]*>([^<]+)<\/(?:[A-Za-z_][\w.-]*:)?pssh\s*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?ContentProtection\s*>/gi;
    const payloads = [];
    let systemBytes = null;
    for (const match of manifest.matchAll(protectionPattern)) {
      try {
        const raw = global.atob(match[1].replace(/\s+/g, ""));
        const box = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        if (box.byteLength < 32 || new TextDecoder().decode(box.subarray(4, 8)) !== "pssh") continue;
        const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
        const declaredLength = view.getUint32(0);
        const payloadLength = view.getUint32(28);
        const boxSystemId = Array.from(box.subarray(12, 28), (value) => value.toString(16).padStart(2, "0")).join("");
        if (declaredLength !== box.byteLength || boxSystemId !== systemId || payloadLength !== box.byteLength - 32) continue;
        const payload = JSON.parse(new TextDecoder().decode(box.subarray(32)));
        if (typeof payload.contentID !== "string" || !Array.isArray(payload.kids)) continue;
        payloads.push(payload);
        systemBytes ??= box.slice(12, 28);
      } catch {
        // Ignore malformed or unrelated boxes. The caller fails closed when
        // no valid WisePlay initialization record remains.
      }
    }
    if (!payloads.length || !systemBytes) return null;
    const contentId = payloads[0].contentID;
    const kids = [...new Set(payloads
      .filter((payload) => payload.contentID === contentId)
      .flatMap((payload) => payload.kids)
      .filter((kid) => typeof kid === "string" && kid.length > 0))];
    if (!kids.length) return null;
    const payload = new TextEncoder().encode(JSON.stringify({ ...payloads[0], kids }));
    const box = new Uint8Array(32 + payload.byteLength);
    const view = new DataView(box.buffer);
    view.setUint32(0, box.byteLength);
    box.set(new TextEncoder().encode("pssh"), 4);
    view.setUint32(8, 0);
    box.set(systemBytes, 12);
    view.setUint32(28, payload.byteLength);
    box.set(payload, 32);
    const statusKids = kids.map(normalizeKid).filter((kid) => /^[0-9a-f]{32}$/.test(kid));
    if (statusKids.length !== kids.length) return null;
    return { data: box, kidCount: statusKids.length, kids: statusKids };
  }

  function playReady40InitData(initData) {
    const playReadySystemId = "9a04f07998404286ab92e65be0885f95";
    const parts = [];
    let offset = 0;
    let changed = false;
    while (offset + 8 <= initData.byteLength) {
      const view = new DataView(initData.buffer, initData.byteOffset + offset, initData.byteLength - offset);
      const size = view.getUint32(0);
      if (size < 8 || offset + size > initData.byteLength) return initData;
      const box = initData.slice(offset, offset + size);
      const type = new TextDecoder().decode(box.subarray(4, 8));
      if (type !== "pssh" || size < 32) {
        parts.push(box);
        offset += size;
        continue;
      }
      const boxView = new DataView(box.buffer, box.byteOffset, box.byteLength);
      const version = box[8];
      const systemId = Array.from(box.subarray(12, 28), (value) => value.toString(16).padStart(2, "0")).join("");
      let dataLengthOffset = 28;
      if (version === 1) {
        if (box.byteLength < 36) return initData;
        dataLengthOffset = 32 + (boxView.getUint32(28) * 16);
      } else if (version !== 0) {
        parts.push(box);
        offset += size;
        continue;
      }
      if (systemId !== playReadySystemId || dataLengthOffset + 4 > box.byteLength) {
        parts.push(box);
        offset += size;
        continue;
      }
      const dataLength = boxView.getUint32(dataLengthOffset);
      const dataOffset = dataLengthOffset + 4;
      if (dataOffset + dataLength !== box.byteLength || dataLength < 10) return initData;
      const pro = box.subarray(dataOffset);
      const proView = new DataView(pro.buffer, pro.byteOffset, pro.byteLength);
      const recordLength = proView.getUint16(8, true);
      if (proView.getUint32(0, true) !== pro.byteLength || proView.getUint16(4, true) !== 1
        || proView.getUint16(6, true) !== 1 || recordLength + 10 !== pro.byteLength) {
        parts.push(box);
        offset += size;
        continue;
      }
      const header = new TextDecoder("utf-16le").decode(pro.subarray(10));
      if (!/version\s*=\s*["']4\.3\.0\.0["']/i.test(header)) {
        parts.push(box);
        offset += size;
        continue;
      }
      const kid = header.match(/<KID\b[^>]*\bVALUE\s*=\s*["']([^"']+)["']/i)?.[1];
      const checksum = header.match(/<KID\b[^>]*\bCHECKSUM\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!kid || !checksum) {
        parts.push(box);
        offset += size;
        continue;
      }
      const normalizedHeader = `<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO><KID>${kid}</KID><CHECKSUM>${checksum}</CHECKSUM></DATA></WRMHEADER>`;
      const headerBytes = new Uint8Array(normalizedHeader.length * 2);
      const headerView = new DataView(headerBytes.buffer);
      for (let index = 0; index < normalizedHeader.length; index += 1) {
        headerView.setUint16(index * 2, normalizedHeader.charCodeAt(index), true);
      }
      const normalizedPro = new Uint8Array(10 + headerBytes.byteLength);
      const normalizedProView = new DataView(normalizedPro.buffer);
      normalizedProView.setUint32(0, normalizedPro.byteLength, true);
      normalizedProView.setUint16(4, 1, true);
      normalizedProView.setUint16(6, 1, true);
      normalizedProView.setUint16(8, headerBytes.byteLength, true);
      normalizedPro.set(headerBytes, 10);
      const normalizedBox = new Uint8Array(32 + normalizedPro.byteLength);
      const normalizedBoxView = new DataView(normalizedBox.buffer);
      normalizedBoxView.setUint32(0, normalizedBox.byteLength);
      normalizedBox.set(new TextEncoder().encode("pssh"), 4);
      normalizedBoxView.setUint32(8, 0);
      normalizedBox.set(box.subarray(12, 28), 12);
      normalizedBoxView.setUint32(28, normalizedPro.byteLength);
      normalizedBox.set(normalizedPro, 32);
      parts.push(normalizedBox);
      changed = true;
      offset += size;
    }
    if (offset !== initData.byteLength || !changed) return initData;
    const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let resultOffset = 0;
    for (const part of parts) {
      result.set(part, resultOffset);
      resultOffset += part.byteLength;
    }
    return result;
  }

  async function loadWisePlayInitData(session, operation) {
    const response = await global.fetch(session.manifestUrl, {
      method: "GET",
      headers: { Accept: "application/dash+xml, application/xml;q=0.9, text/xml;q=0.8" },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw new Error("The WisePlay DASH manifest could not be inspected.");
    const declaredLength = Number(response.headers?.get?.("Content-Length") || 0);
    if (declaredLength > MAXIMUM_WISEPLAY_MANIFEST_BYTES) {
      throw new Error("The WisePlay DASH manifest exceeds the validation limit.");
    }
    const manifest = await response.text();
    if (new TextEncoder().encode(manifest).byteLength > MAXIMUM_WISEPLAY_MANIFEST_BYTES) {
      throw new Error("The WisePlay DASH manifest exceeds the validation limit.");
    }
    const canonical = wisePlayCanonicalInitData(manifest);
    if (!canonical) {
      throw new Error("The DASH manifest does not contain valid WisePlay initialization data.");
    }
    report(operation, "wiseplay.init-data-normalized", {
      keyCount: canonical.kidCount,
      duplicateInitDataIgnored: true,
      parseInbandPsshEnabled: false,
      emeSessionModel: "single-canonical-session",
    });
    return canonical;
  }

  function reportingContext() {
    const navigator = global.navigator || {};
    const agent = navigator.userAgent || "";
    return {
      deviceId: reportingDeviceId,
      deviceType: /iPad|Tablet/i.test(agent) ? "tablet"
        : /Android|iPhone|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(agent) ? "mobile" : "desktop",
      platform: navigator.userAgentData?.platform || navigator.platform || "Unknown",
      browser: /HuaweiBrowser|HBPC/i.test(agent) ? "Huawei Browser"
        : /Edg\//i.test(agent) ? "Edge"
          : /CriOS|Chrome\//i.test(agent) ? "Chrome"
          : /Safari\//i.test(agent) ? "Safari"
            : /Firefox\//i.test(agent) ? "Firefox"
              : "Other",
    };
  }

  function normalizeSession(value) {
    if (!value || typeof value !== "object") throw new Error("The playback endpoint returned no session.");
    if (Number(value.contractVersion) !== CONTRACT_VERSION) {
      throw new Error(`Unsupported playback contract version: ${value.contractVersion ?? "missing"}.`);
    }
    const directToken = value.drm?.drmLicenseToken || value.drmLicenseToken || value.token || "";
    const normalizeAuthorization = (descriptor, fallbackValue, fallbackScheme = "Bearer") => {
      const headerName = String(descriptor?.headerName || "Authorization").trim();
      const scheme = String(descriptor?.scheme || fallbackScheme).trim();
      const authorizationValue = String(descriptor?.value || fallbackValue || "").trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName) || !/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(scheme)
        || !authorizationValue || /[\r\n]/.test(authorizationValue)) {
        throw new Error("The playback endpoint returned an invalid authorization descriptor.");
      }
      return { headerName, scheme, value: authorizationValue };
    };
    const licenseAuthorization = normalizeAuthorization(
      value.drm?.authorization,
      directToken,
      value.drm?.tokenType || value.tokenType || "Bearer",
    );
    const releaseAuthorization = normalizeAuthorization(
      value.release?.authorization,
      licenseAuthorization.value,
      value.release?.authorizationScheme || licenseAuthorization.scheme,
    );
    const integrationMode = value.drm?.integrationMode || "direct-token";
    if (integrationMode !== "direct-token" && integrationMode !== "token-proxy") {
      throw new Error("The playback endpoint returned an unsupported license integration mode.");
    }
    const normalized = {
      ...value,
      integrationMode,
      token: licenseAuthorization.value,
      tokenType: licenseAuthorization.scheme,
      licenseAuthorization,
      releaseAuthorization,
      licenseServerUrl: value.drm?.licenseServerUrl || value.licenseServerUrl,
      fairPlayCertificateUrl: value.drm?.fairPlayCertificateUrl || value.fairPlayCertificateUrl || null,
      releaseUrl: value.release?.url || value.releaseUrl,
      maximumHeight: Number(value.policy?.maximumHeight ?? value.maximumHeight),
      allowedTrackTypes: value.policy?.allowedTrackTypes || value.allowedTrackTypes || [],
    };
    if (!normalized.sessionId || !normalized.contentId || !normalized.manifestUrl
      || !normalized.token || !normalized.licenseServerUrl || !normalized.releaseUrl
      || !Number.isInteger(normalized.maximumHeight)
      || normalized.maximumHeight < 1 || normalized.maximumHeight > 4320) {
      throw new Error("The playback endpoint returned an incomplete Contract v1 session.");
    }
    return normalized;
  }

  async function requestSession(endpoint, contentId, selection, operation, additionalCapabilities, contentType) {
    report(operation, "session.request", { drmSystem: selection.drmSystem });
    const response = await global.fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: operation.controller.signal,
      body: JSON.stringify({
        contentId,
        contentType,
        attemptId: operation.attemptId,
        drmSystem: selection.drmSystem,
        playbackMode: "streaming",
        platformCapabilities: {
          ...platformCapabilities(selection),
          ...(additionalCapabilities || {}),
          drmSystems: [selection.drmSystem],
        },
        reporting: reportingContext(),
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.title || "Your backend did not authorize playback.");
      error.code = body?.code || "playback_session_unavailable";
      error.status = response.status;
      error.retryable = Boolean(body?.retryable);
      error.requestId = body?.requestId || null;
      report(operation, "session.rejected", {
        status: response.status,
        errorCode: error.code,
        requestId: error.requestId,
      }, "warning");
      throw error;
    }
    report(operation, "session.authorized", { status: response.status, drmSystem: selection.drmSystem });
    return normalizeSession(body);
  }

  async function release(session) {
    if (!session?.token || !session?.releaseUrl || session.released) return;
    session.released = true;
    report(session.operation, "session.release", { reason: session.releaseReason || "stop" });
    try {
      const response = await boundedFetch(session.releaseUrl, {
        method: "POST",
        headers: {
          [session.releaseAuthorization.headerName]:
            `${session.releaseAuthorization.scheme} ${session.releaseAuthorization.value}`,
        },
        body: "",
        cache: "no-store",
        keepalive: true,
      }, 8_000);
      if (!response.ok) throw new Error("The playback reservation release was rejected.");
      report(session.operation, "session.released");
    } catch (error) {
      report(session.operation, "session.release-failed", errorDetails(error), "warning");
    }
  }

  function resetVideo(video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  async function dispose(video, reset = true, reason = "stop") {
    const session = active.get(video);
    if (session) {
      active.delete(video);
      session.releaseReason = reason;
    }
    liveVideos.delete(video);
    let pending = disposals.get(video);
    if (session && !session.disposal) {
      // Shaka owns MediaSource/MediaKeys teardown. A competing load() here can
      // interrupt Android's detach; later starts must share this same teardown.
      const mediaCleanup = (async () => {
        await session.player?.destroy();
        if (reset) resetVideo(video);
      })();
      pending = session.disposal = Promise.all([mediaCleanup, release(session)]);
      disposals.set(video, pending);
      const completed = () => {
        if (disposals.get(video) === pending) disposals.delete(video);
        void flushLogs(session.operation, true);
      };
      pending.then(completed, completed);
    } else if (!pending && reset) resetVideo(video);
    if (pending) await withDeadline(pending, 15_000, "player_cleanup_timeout",
      "The previous video could not close. Reload this page to restart the player.");
  }

  function ensureVideo(video) {
    if (!(video instanceof global.HTMLVideoElement)) throw new Error("Provide one HTMLVideoElement.");
  }

  function shakaKeyMapping(selection) {
    if (selection.drmSystem !== "playready") {
      const base = baseKeySystems[selection.drmSystem];
      return selection.keySystem === base ? {} : { [base]: selection.keySystem };
    }
    return {
      "com.microsoft.playready": selection.keySystem,
      "com.microsoft.playready.recommendation": selection.keySystem,
      "com.microsoft.playready.recommendation.3000": selection.keySystem,
    };
  }

  function trackLanguage(track) {
    const value = track?.language || track?.originalLanguage || "";
    if (!value) return "";
    try { return Intl.getCanonicalLocales(value)[0] || ""; } catch { return ""; }
  }

  function normalizeKid(value) {
    const raw = String(value || "").trim();
    const hexadecimal = raw.replace(/^0x/i, "").replaceAll("-", "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(hexadecimal) || hexadecimal === "00") return hexadecimal;
    const base64 = raw.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      try {
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const decoded = global.atob(padded);
        if (decoded.length === 16) {
          return Array.from(decoded, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        }
      } catch {
        // Fall through to the safe string normalization below.
      }
    }
    return hexadecimal;
  }

  function playbackReplacedError() {
    return new global.DOMException("Playback was replaced.", "AbortError");
  }

  const terminalKeyStatuses = new Set(["expired", "internal-error", "output-restricted", "released"]);

  function wisePlayKeyReadiness(player, expectedKids) {
    const normalizedExpectedKids = [...new Set(expectedKids.map(normalizeKid).filter(Boolean))];
    const rawStatuses = player.getKeyStatuses?.() || new Map();
    const entries = rawStatuses && typeof rawStatuses.entries === "function"
      ? Array.from(rawStatuses.entries())
      : Object.entries(rawStatuses);
    const normalizedEntries = entries.map(([kid, status]) => [normalizeKid(kid), String(status)]);
    const statusesByKid = new Map(normalizedEntries);
    const globalStatuses = normalizedEntries
      .filter(([kid]) => kid === "00" || /^0{32}$/.test(kid))
      .map(([, status]) => status);
    const expectedStatuses = normalizedExpectedKids
      .map((kid) => statusesByKid.get(kid))
      .filter((status) => status !== undefined);
    const explicitManifestFailure = expectedStatuses.some((status) => terminalKeyStatuses.has(status));
    const globalTerminalFailure = globalStatuses.some((status) => terminalKeyStatuses.has(status));
    const globalKeyStatus = globalStatuses.includes("usable")
      ? "usable"
      : globalStatuses[0] || null;
    const allManifestKeysUsable = normalizedExpectedKids.length > 0
      && normalizedExpectedKids.every((kid) => statusesByKid.get(kid) === "usable");

    return {
      usable: !explicitManifestFailure
        && !globalTerminalFailure
        && (globalKeyStatus === "usable" || allManifestKeysUsable),
      reportedKeyCount: normalizedEntries.length,
      matchedManifestKeyCount: expectedStatuses.length,
      globalKeyStatus,
      explicitManifestFailure,
    };
  }

  async function waitForUsableKeyBeforePlay(player, timeoutMs, expectedKids, signal, isCurrent) {
    const normalizedExpectedKids = [...new Set(expectedKids.map(normalizeKid).filter(Boolean))];
    let readiness = {
      usable: false,
      reportedKeyCount: 0,
      matchedManifestKeyCount: 0,
      globalKeyStatus: null,
      explicitManifestFailure: false,
    };
    if (!normalizedExpectedKids.length) return readiness;
    const now = () => global.performance?.now?.() ?? Date.now();
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (signal?.aborted || !isCurrent()) throw playbackReplacedError();
      readiness = wisePlayKeyReadiness(player, normalizedExpectedKids);
      if (readiness.usable) return readiness;
      await new Promise((resolve) => global.setTimeout(resolve, 100));
    }
    if (signal?.aborted || !isCurrent()) throw playbackReplacedError();
    return readiness;
  }

  function withPlaybackStartupTimeout(promise, timeoutMs, signal, isCurrent) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        signal?.removeEventListener?.("abort", abort);
        handler(value);
      };
      const abort = () => finish(reject, playbackReplacedError());
      const timer = global.setTimeout(() => {
        if (!isCurrent()) {
          finish(reject, playbackReplacedError());
          return;
        }
        const error = new Error(`Edge PlayReady did not begin protected playback within ${Math.round(timeoutMs / 1_000)} seconds.`);
        error.code = "playready_startup_timeout";
        finish(reject, error);
      }, timeoutMs);
      signal?.addEventListener?.("abort", abort, { once: true });
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  function requireQualifiedWisePlayRuntime(selection) {
    if (selection.drmSystem !== "wiseplay") return;
    const runtime = global.shaka?.__drmxQualifiedRuntime;
    if (runtime?.wisePlayDuplicateInitialLicenseSuppression !== true
        || runtime?.wisePlayGlobalKeyStatusNormalization !== true) {
      throw new Error("Load the DRM-X-qualified Shaka Player runtime for Huawei WisePlay.");
    }
  }

  function audioTrackId(track, index) {
    return String(track?.id ?? track?.audioId ?? `${trackLanguage(track) || "und"}-${track?.channelsCount || 0}-${index}`);
  }

  function getAudioTracks(video) {
    const player = active.get(video)?.player;
    if (!player) return [];
    const source = player.getAudioTracks?.() || player.getVariantTracks?.() || [];
    const seen = new Set();
    return source.map((track, index) => ({
      id: audioTrackId(track, index),
      language: trackLanguage(track),
      label: track.label || trackLanguage(track) || `Audio ${index + 1}`,
      role: track.audioRoles?.[0] || track.roles?.[0] || "",
      channelsCount: Number(track.channelsCount || 0) || null,
      codec: track.audioCodec || track.codecs || "",
      active: Boolean(track.active),
      _track: track,
    })).filter((track) => {
      const identity = `${track.id}|${track.language}|${track.role}|${track.channelsCount}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  function getSubtitleTracks(video) {
    const player = active.get(video)?.player;
    if (!player) return [];
    return (player.getTextTracks?.() || []).map((track, index) => ({
      id: String(track.id ?? `${trackLanguage(track) || "und"}-${index}`),
      language: trackLanguage(track),
      label: track.label || trackLanguage(track) || `Subtitles ${index + 1}`,
      role: track.roles?.[0] || "",
      active: Boolean(track.active),
      _track: track,
    }));
  }

  function getQualityOptions(video) {
    const session = active.get(video);
    if (!session?.player) return [];
    const groups = new Map();
    for (const track of session.player.getVariantTracks?.() || []) {
      const height = Number(track.height || 0);
      if (!height || height > session.maximumHeight || track.allowedByApplication === false || track.allowedByKeySystem === false) continue;
      const current = groups.get(height);
      if (!current || Number(track.bandwidth || 0) > current.bandwidth) {
        groups.set(height, {
          id: String(height),
          height,
          width: Number(track.width || 0) || null,
          bandwidth: Number(track.bandwidth || 0),
          codec: track.videoCodec || track.codecs || "",
          active: Boolean(track.active),
        });
      } else if (track.active) {
        current.active = true;
      }
    }
    return [...groups.values()].sort((left, right) => right.height - left.height);
  }

  function getTracks(video) {
    const audioTracks = getAudioTracks(video);
    const subtitleTracks = getSubtitleTracks(video);
    const unique = (values) => [...new Set(values.filter(Boolean))];
    return {
      audioLanguages: unique(audioTracks.map((track) => track.language)),
      subtitleLanguages: unique(subtitleTracks.map((track) => track.language)),
      audioTracks: audioTracks.map(({ _track, ...track }) => track),
      subtitleTracks: subtitleTracks.map(({ _track, ...track }) => track),
      qualityOptions: getQualityOptions(video),
      qualityMode: active.get(video)?.qualityMode || "auto",
    };
  }

  function selectAudioTrack(video, id) {
    const session = active.get(video);
    if (!session?.player) throw new Error("Start protected playback before selecting audio.");
    const option = getAudioTracks(video).find((track) => track.id === String(id));
    if (!option) throw new Error(`Audio track ${id} is not available.`);
    if (session.player.selectAudioTrack) session.player.selectAudioTrack(option._track);
    else session.player.selectVariantTrack?.(option._track, true);
    report(session.operation, "selection.audio", {
      language: option.language,
      role: option.role,
      channelsCount: option.channelsCount,
    });
    emit(video, "drmxselection", { type: "audio", value: option.id });
  }

  function selectAudioLanguage(video, language) {
    const canonical = Intl.getCanonicalLocales(language)[0];
    const option = getAudioTracks(video).find((track) => track.language === canonical);
    if (!option) throw new Error(`Audio track ${canonical} is not available.`);
    selectAudioTrack(video, option.id);
  }

  function selectSubtitleTrack(video, id) {
    const session = active.get(video);
    if (!session?.player) throw new Error("Start protected playback before selecting subtitles.");
    const option = getSubtitleTracks(video).find((track) => track.id === String(id));
    if (!option) throw new Error(`Subtitle track ${id} is not available.`);
    session.player.selectTextTrack?.(option._track);
    session.player.setTextTrackVisibility?.(true);
    report(session.operation, "selection.subtitles", { language: option.language, role: option.role });
    emit(video, "drmxselection", { type: "subtitles", value: option.id });
  }

  function selectSubtitleLanguage(video, language) {
    const canonical = Intl.getCanonicalLocales(language)[0];
    const option = getSubtitleTracks(video).find((track) => track.language === canonical);
    if (!option) throw new Error(`Subtitle track ${canonical} is not available.`);
    selectSubtitleTrack(video, option.id);
  }

  function hideSubtitles(video) {
    const session = active.get(video);
    if (!session?.player) return;
    if (session.player.selectTextTrack) session.player.selectTextTrack(null);
    else session.player.setTextTrackVisibility?.(false);
    report(session.operation, "selection.subtitles", { value: "off" });
    emit(video, "drmxselection", { type: "subtitles", value: "off" });
  }

  function selectQuality(video, value) {
    const session = active.get(video);
    if (!session?.player) throw new Error("Start protected playback before selecting quality.");
    if (String(value).toLowerCase() === "auto") {
      session.qualityMode = "auto";
      const maximumHeight = session.automaticMaximumHeight || session.playbackMaximumHeight || session.maximumHeight;
      const playbackMaximumHeight = session.playbackMaximumHeight || session.maximumHeight;
      session.player.configure({
        abr: { enabled: true, restrictions: { minHeight: 0, maxHeight: maximumHeight } },
        restrictions: { minHeight: 0, maxHeight: playbackMaximumHeight },
      });
      report(session.operation, "selection.quality", { value: "auto", maximumHeight });
      emit(video, "drmxselection", { type: "quality", value: "auto" });
      return;
    }
    const height = Number(value);
    const playbackMaximumHeight = session.playbackMaximumHeight || session.maximumHeight;
    if (!Number.isInteger(height) || height < 1 || height > playbackMaximumHeight) {
      throw new Error("The requested quality is outside the authorized policy ceiling.");
    }
    const variants = (session.player.getVariantTracks?.() || []).filter((track) =>
      Number(track.height) === height
      && track.allowedByApplication !== false
      && track.allowedByKeySystem !== false);
    if (!variants.length) throw new Error(`${height}p is not available.`);
    const activeAudio = getAudioTracks(video).find((track) => track.active);
    const chosen = variants.find((track) => !activeAudio || trackLanguage(track) === activeAudio.language) || variants[0];
    session.qualityMode = String(height);
    session.player.configure({
      abr: { enabled: false, restrictions: { minHeight: 0, maxHeight: playbackMaximumHeight } },
      restrictions: { minHeight: 0, maxHeight: playbackMaximumHeight },
    });
    const preserveBuffer = session.drmSystem === "wiseplay" || session.drmSystem === "playready";
    session.player.selectVariantTrack?.(chosen, !preserveBuffer, 12);
    report(session.operation, "selection.quality", { value: `${height}p` });
    emit(video, "drmxselection", { type: "quality", value: String(height) });
  }

  function adEventNames() {
    const utils = global.shaka?.ads?.Utils || {};
    return [
      [utils.AD_STARTED, "started"],
      [utils.AD_COMPLETE, "complete"],
      [utils.AD_SKIPPED, "skipped"],
      [utils.AD_ERROR, "error"],
      [utils.AD_PAUSED, "paused"],
      [utils.AD_RESUMED, "resumed"],
    ].filter(([name]) => typeof name === "string" && name);
  }

  async function configureAds(player, video, session, options) {
    if (!options.adTagUrl) return;
    const adManager = player.getAdManager?.();
    if (!adManager?.addAdUrlInterstitial) {
      report(session.operation, "ads.unsupported", {}, "warning");
      emit(video, "drmxaderror", { code: "ads_unsupported", message: "This Shaka build does not support VAST/VMAP ads." });
      return;
    }
    if (options.adContainer && adManager.setContainers) adManager.setContainers(options.adContainer, null);
    for (const [name, status] of adEventNames()) {
      adManager.addEventListener?.(name, () => {
        report(session.operation, `ads.${status}`, {}, status === "error" ? "warning" : "info");
        emit(video, "drmxad", { status });
      });
    }
    try {
      await adManager.addAdUrlInterstitial(options.adTagUrl);
      report(session.operation, "ads.loaded", { standard: "VAST/VMAP" });
    } catch (error) {
      report(session.operation, "ads.load-failed", errorDetails(error), "warning");
      emit(video, "drmxaderror", { code: "ad_tag_failed", message: "The VAST/VMAP ad tag could not be loaded." });
    }
  }

  async function createPlayer(video, session, selection, operation, options, nativeFairPlay) {
    const player = new global.shaka.Player();
    session.player = player;
    session.generation = (session.generation || 0) + 1;
    session.nativeFairPlay = nativeFairPlay;
    const generation = session.generation;
    active.set(video, session);
    await player.attach(video);
    if (active.get(video) !== session || operation.controller.signal.aborted) throw playbackReplacedError();

    const serverMap = {
      [baseKeySystems[selection.drmSystem]]: session.licenseServerUrl,
      [selection.keySystem]: session.licenseServerUrl,
    };
    const advanced = selection.drmSystem === "fairplay"
      ? { [selection.keySystem]: { serverCertificateUri: session.fairPlayCertificateUrl } }
      : {};
    if (selection.drmSystem === "fairplay" && !session.fairPlayCertificateUrl) {
      throw new Error("The playback session omitted the FairPlay certificate URL.");
    }
    const wisePlayInitData = selection.drmSystem === "wiseplay"
      ? await loadWisePlayInitData(session, operation)
      : null;
    session.wisePlayExpectedKids = wisePlayInitData?.kids || [];
    const playReadyHardwarePath = selection.drmSystem === "playready" && /\.3000$/i.test(selection.keySystem);
    const playbackMaximumHeight = selection.drmSystem === "playready" && !playReadyHardwarePath
      ? Math.min(session.maximumHeight, PLAYREADY_SOFTWARE_MAXIMUM_HEIGHT)
      : session.maximumHeight;
    session.widevineAndroidStartup = selection.drmSystem === "widevine"
      && (/Android/i.test(global.navigator?.userAgent || "")
        || global.navigator?.userAgentData?.platform === "Android");
    // Android MediaCodec can remain blocked on an unlicensed HD sample even
    // after the CDM restricts ABR to SD. Start with the policy's SD rendition
    // before buffering HD; restore the normal ceiling after decoded playback.
    const automaticMaximumHeight = selection.drmSystem === "playready"
      ? Math.min(playbackMaximumHeight, PLAYREADY_STARTUP_MAXIMUM_HEIGHT)
      : session.widevineAndroidStartup
        ? Math.min(playbackMaximumHeight, WIDEVINE_ANDROID_STARTUP_MAXIMUM_HEIGHT)
      : selection.drmSystem === "wiseplay"
        ? Math.min(session.maximumHeight, WISEPLAY_AUTOMATIC_MAXIMUM_HEIGHT)
        : session.maximumHeight;
    session.playbackMaximumHeight = playbackMaximumHeight;
    session.automaticMaximumHeight = automaticMaximumHeight;
    session.startupMaximumHeight = automaticMaximumHeight;
    player.configure({
      abr: {
        enabled: true,
        restrictions: { minHeight: 0, maxHeight: automaticMaximumHeight },
        useNetworkInformation: true,
        defaultBandwidthEstimate: 1_200_000,
        ...(selection.drmSystem === "wiseplay" ? {
          switchInterval: 12,
          bandwidthUpgradeTarget: 0.55,
          bandwidthDowngradeTarget: 0.95,
          cacheLoadThreshold: 100,
          minTimeToSwitch: 10,
        } : {}),
      },
      restrictions: { minHeight: 0, maxHeight: playbackMaximumHeight },
      drm: {
        servers: serverMap,
        preferredKeySystems: [selection.keySystem],
        keySystemsMapping: shakaKeyMapping(selection),
        advanced,
        retryParameters: networkRetryParameters(3),
        ignoreDuplicateInitData: true,
        parseInbandPsshEnabled: false,
        ...(selection.drmSystem === "playready" ? {
          initDataTransform: (initData, initDataType, _drmInfo) =>
            initDataType === "cenc" ? playReady40InitData(initData) : initData,
        } : wisePlayInitData ? {
          initDataTransform: (initData, initDataType, _drmInfo) =>
            initDataType === "cenc" ? wisePlayInitData.data.slice() : initData,
        } : {}),
      },
      manifest: { retryParameters: networkRetryParameters(3) },
      cmcd: { enabled: true, sessionId: session.sessionId, contentId: session.contentId, useHeaders: false },
      streaming: {
        useNativeHlsForFairPlay: selection.drmSystem === "fairplay" && nativeFairPlay,
        bufferingGoal: 24,
        rebufferingGoal: 6,
        segmentPrefetchLimit: selection.drmSystem === "wiseplay" ? 1 : 2,
        retryParameters: networkRetryParameters(4),
      },
    });
    if (selection.drmSystem === "wiseplay" && automaticMaximumHeight < session.maximumHeight) {
      report(operation, "wiseplay.automatic-ceiling", {
        automaticMaximumHeight,
        policyMaximumHeight: session.maximumHeight,
        reason: "stable-single-rendition-startup",
      });
    }
    if (selection.drmSystem === "playready") {
      report(operation, "playready.startup-ceiling", {
        startupMaximumHeight: automaticMaximumHeight,
        playbackMaximumHeight,
        policyMaximumHeight: session.maximumHeight,
        keySystem: selection.keySystem,
        path: playReadyHardwarePath ? "hardware" : "software",
        reason: "decoded-sd-first",
      });
    }
    if (session.widevineAndroidStartup) {
      report(operation, "widevine.startup-ceiling", {
        startupMaximumHeight: automaticMaximumHeight,
        policyMaximumHeight: playbackMaximumHeight,
        reason: "decoded-sd-first",
      });
    }
    const requestTypes = global.shaka.net.NetworkingEngine.RequestType;
    player.getNetworkingEngine().registerRequestFilter((type, request) => {
      if (type !== requestTypes.LICENSE && type !== requestTypes.SERVER_CERTIFICATE) return;
      if (type === requestTypes.LICENSE) report(operation, "drm.license-request");
      request.headers ??= {};
      request.headers[session.licenseAuthorization.headerName] =
        `${session.licenseAuthorization.scheme} ${session.licenseAuthorization.value}`;
    });
    player.addEventListener?.("keystatuschanged", () => {
      if (active.get(video) !== session || session.generation !== generation) return;
      const raw = player.getKeyStatuses?.();
      const values = raw instanceof Map ? [...raw.values()] : Object.values(raw || {});
      session.keyStatuses = [...new Set(values.map(String))];
      report(operation, "drm.key-status", { statuses: session.keyStatuses });
      if (session.keyStatuses.includes("usable")) report(operation, "drm.keys-ready");
    });
    player.addEventListener?.("adaptation", () => {
      if (active.get(video) !== session || session.generation !== generation) return;
      const current = getQualityOptions(video).find((track) => track.active);
      report(operation, "quality.adaptation", { height: current?.height || null }, "debug");
      emit(video, "drmxqualitychange", { mode: session.qualityMode, height: current?.height || null });
    });
    await configureAds(player, video, session, options);
    return player;
  }

  async function loadWithResume(player, video, session, options) {
    const requested=options.startPosition;
    const validPosition=()=>{
      const range=player.seekRange?.();
      const start=Number.isFinite(range?.start)?range.start:0;
      const end=Number.isFinite(range?.end)&&range.end>start?range.end:video.duration;
      if(!Number.isFinite(end)||end<=start)return null;
      return requested>=start&&requested<end-10?requested:start;
    };
    const updateStart=()=>{
      if(requested==null)return;
      const position=validPosition();
      if(position!=null)player.updateStartTime(position);
    };
    // Shaka creates its playhead after parsing the manifest. A currentTime seek
    // after load() can still be overwritten when delayed metadata arrives.
    player.addEventListener?.('canupdatestarttime',updateStart);
    try {await player.load(session.manifestUrl,requested);}
    finally {player.removeEventListener?.('canupdatestarttime',updateStart);}
    // Native HLS learns the duration later than the MSE manifest event.
    if(requested!=null){
      const position=validPosition();
      if(position!=null&&position!==requested&&video.readyState>=1)video.currentTime=position;
      report(session.operation,'media.resume',{position:position??requested});
    }
  }

  async function loadWithFairPlayFallback(video, session, selection, operation, options) {
    let player;
    try {
      player = await createPlayer(video, session, selection, operation, options, selection.drmSystem === "fairplay");
      assertCurrentOperation(operation);
      report(operation, "manifest.load", { playbackPath: session.nativeFairPlay ? "fairplay-native-hls" : "mse-eme" });
      await loadWithResume(player, video, session, options);
      return player;
    } catch (error) {
      if (selection.drmSystem !== "fairplay" || !canUseFairPlayMse(session) || session.fairPlayFallbackTried
          || operation.controller.signal.aborted || operations.get(video) !== operation) throw error;
      session.fairPlayFallbackTried = true;
      report(operation, "fairplay.native-failed", errorDetails(error), "warning");
      try { await player?.destroy(); } catch { /* best effort */ }
      assertCurrentOperation(operation);
      resetVideo(video);
      report(operation, "fairplay.mse-fallback", { from: "native-hls", to: "mse-eme" }, "warning");
      player = await createPlayer(video, session, selection, operation, options, false);
      await loadWithResume(player, video, session, options);
      emit(video, "drmxfallback", { drmSystem: "fairplay", playbackPath: "mse-eme" });
      return player;
    }
  }

  async function runtimeFairPlayFallback(video, session, selection, options, cause) {
    if (!canUseFairPlayMse(session)) throw cause;
    if (session.fairPlayFallbackTried || !session.nativeFairPlay || session.fallbackPromise) return session.fallbackPromise;
    session.fairPlayFallbackTried = true;
    session.fallbackPromise = (async () => {
      report(session.operation, "fairplay.runtime-fallback", errorDetails(cause), "warning");
      const prior = session.player;
      session.generation += 1;
      try { await prior?.destroy(); } catch { /* best effort */ }
      resetVideo(video);
      const player = await createPlayer(video, session, selection, session.operation, options, false);
      await player.load(session.manifestUrl);
      const tracks = getTracks(video);
      emit(video, "drmxtracks", tracks);
      emit(video, "drmxfallback", { drmSystem: "fairplay", playbackPath: "mse-eme" });
      try { await video.play(); } catch (error) {
        if (error?.name !== "NotAllowedError") throw error;
      }
      return player;
    })();
    try { return await session.fallbackPromise; }
    finally { session.fallbackPromise = null; }
  }

  function installRuntimeHandlers(video, session, selection, options) {
    let rejectStartupFailure;
    const startupFailure = new Promise((_, reject) => { rejectStartupFailure = reject; });
    session.startupPending = true;
    const bind = (player, generation) => {
      player.addEventListener?.("error", (event) => {
        if (active.get(video) !== session || session.generation !== generation) return;
        const error = event?.detail || event || new Error("Shaka playback error.");
        report(session.operation, "player.error", errorDetails(error), "error");
        if (selection.drmSystem === "widevine"
            && session.startupPending
            && isWidevineSessionAuthenticationFailure(error)) {
          session.startupPending = false;
          rejectStartupFailure(error);
        } else if (selection.drmSystem === "fairplay" && session.nativeFairPlay && !session.fairPlayFallbackTried
            && canUseFairPlayMse(session)) {
          void runtimeFairPlayFallback(video, session, selection, options, error)
            .then((replacement) => bind(replacement, session.generation))
            .catch((fallbackError) => failRuntime(video, session, fallbackError));
        } else if (selection.drmSystem === "fairplay" && session.startupPending) rejectStartupFailure(error);
        else void failRuntime(video, session, error);
      });
    };
    bind(session.player, session.generation);
    video.addEventListener("error", () => {
      if (active.get(video) !== session) return;
      const error = video.error || new Error("HTML media playback error.");
      report(session.operation, "media.error", {
        code: error?.code || null,
        message: error?.message || "HTML media playback error.",
      }, "error");
      if (selection.drmSystem === "fairplay" && session.nativeFairPlay && !session.fairPlayFallbackTried
          && canUseFairPlayMse(session)) {
        void runtimeFairPlayFallback(video, session, selection, options, error)
          .then((replacement) => bind(replacement, session.generation))
          .catch((fallbackError) => failRuntime(video, session, fallbackError));
      } else if (selection.drmSystem === "fairplay" && session.startupPending) rejectStartupFailure(error);
      else void failRuntime(video, session, error);
    });
    video.addEventListener("ended", () => {
      if (active.get(video) === session) void stop(video, "ended");
    }, { once: true });
    video.addEventListener("waiting", () => {
      if (active.get(video) === session) report(session.operation, "media.buffering", {}, "debug");
    });
    video.addEventListener("playing", () => {
      if (active.get(video) !== session) return;
      report(session.operation, "media.playing");
      if ((selection.drmSystem === "playready" || session.widevineAndroidStartup)
          && session.playbackStartedAt == null) {
        session.playbackStartedAt = Number(video.currentTime || 0);
      }
    });
    video.addEventListener("timeupdate", () => {
      if (active.get(video) !== session
          || (selection.drmSystem !== "playready" && !session.widevineAndroidStartup)
          || session.startupQualityPromoted
          || session.playbackStartedAt == null
          || session.qualityMode !== "auto"
          || video.paused
          || Number(video.readyState || 0) < 3
          || Number(video.currentTime || 0) - session.playbackStartedAt < STARTUP_PROMOTION_SECONDS) return;
      session.startupQualityPromoted = true;
      session.automaticMaximumHeight = session.playbackMaximumHeight;
      session.player.configure({
        abr: { enabled: true, restrictions: { minHeight: 0, maxHeight: session.playbackMaximumHeight } },
        restrictions: { minHeight: 0, maxHeight: session.playbackMaximumHeight },
      });
      report(session.operation, `${selection.drmSystem}.quality-promoted`, {
        fromMaximumHeight: session.startupMaximumHeight,
        toMaximumHeight: session.playbackMaximumHeight,
        stablePlaybackSeconds: Math.round((Number(video.currentTime || 0) - session.playbackStartedAt) * 10) / 10,
        reason: "licensed-decoded-playback-proven",
      });
    });
    return startupFailure;
  }

  async function failRuntime(video, session, error) {
    if (active.get(video) !== session) return;
    emit(video, "drmxerror", { code: error?.code || "playback_failed", message: error?.message || "Playback failed." });
    await dispose(video, true, "terminal-error");
  }

  async function start({
    video,
    contentId,
    contentKey,
    contentType = "vod",
    drmSystem = "auto",
    sessionEndpoint = "/api/drmx/playback-session",
    logEndpoint = null,
    platformCapabilities: additionalCapabilities,
    adTagUrl = null,
    adContainer = null,
    startPosition = null,
    _widevineAuthenticationRetry = 0,
    _playReadyFallback = 0,
  } = {}) {
    ensureVideo(video);
    const selectedContentId = String(contentId || contentKey || "").trim();
    if (!selectedContentId) throw new Error("Provide a DRM-X Content ID.");
    if (!global.shaka) throw new Error("Load the qualified Shaka Player runtime before the DRM-X SDK.");

    operations.get(video)?.controller.abort();
    const operation = {
      id: ++sequence,
      attemptId: attemptId(),
      controller: new global.AbortController(),
      video,
      contentId: selectedContentId,
      logEndpoint: logEndpoint ? String(logEndpoint) : null,
      logQueue: [],
      logTimer: null,
    };
    operations.set(video, operation);
    let session;
    let selection;
    try {
      report(operation, "player.cleanup");
      await dispose(video, true, "replaced");
      assertCurrentOperation(operation);
      global.shaka.polyfill.installAll();
      prepareNativeFairPlay(drmSystem, operation);
      if (!global.shaka.Player.isBrowserSupported()) throw new Error("Shaka cannot run on this browser.");
      report(operation, "player.start", { requestedDrm: drmSystem, sdkVersion: SDK_VERSION });
      selection = await startupStage(selectDrm(drmSystem, operation), operation, 15_000,
        "drm_probe_timeout", "DRM detection timed out. Reload the page and try again.");
      assertCurrentOperation(operation);
      requireQualifiedWisePlayRuntime(selection);
      const sessionRequest = requestSession(
        sessionEndpoint,
        selectedContentId,
        selection,
        operation,
        additionalCapabilities,
        contentType === "live" ? "live" : "vod",
      );
      // A response can arrive after cancellation, even when fetch was aborted.
      // Release only that abandoned response, never the newer active video.
      sessionRequest.then(value => {
        if (operation.controller.signal.aborted || operations.get(video) !== operation) void release(value);
      }, () => {});
      session = await startupStage(sessionRequest, operation, 20_000,
        "playback_session_timeout", "Playback authorization timed out. Check your connection and try again.");
      if (session.contentId !== selectedContentId
          || session.drmSystem !== selection.drmSystem
          || session.drm?.system !== selection.drmSystem) {
        throw new Error("The playback session is not bound to the requested Content ID and DRM system.");
      }
      if (operations.get(video) !== operation) throw new global.DOMException("Replaced", "AbortError");

      Object.assign(session, {
        operation,
        drmSystem: selection.drmSystem,
        // Rotating HLS uses native FairPlay SKD/IV signaling. MSE/SINF can
        // request the initialization segment's stale default KID instead.
        contentType: contentType === "live" ? "live" : "vod",
        selection,
        qualityMode: "auto",
        released: false,
      });
      active.set(video, session);
      liveVideos.add(video);
      const playerOptions = { adTagUrl: adTagUrl ? String(adTagUrl) : null, adContainer,
        startPosition:contentType!=='live'&&Number.isFinite(startPosition)&&startPosition>0?startPosition:null };
      await startupStage(loadWithFairPlayFallback(video, session, selection, operation, playerOptions),
        operation, 45_000, "media_load_timeout", "Protected media or its DRM license took too long to load. Try again.");
      assertCurrentOperation(operation);
      const tracks = getTracks(video);
      report(operation, "tracks.discovered", {
        audio: tracks.audioTracks.map((track) => ({ language: track.language, role: track.role, channelsCount: track.channelsCount })),
        subtitles: tracks.subtitleTracks.map((track) => ({ language: track.language, role: track.role })),
        qualityHeights: tracks.qualityOptions.map((track) => track.height),
      });
      emit(video, "drmxtracks", tracks);
      const startupFailure = installRuntimeHandlers(video, session, selection, playerOptions);
      if (selection.drmSystem === "wiseplay") {
        const keyReadiness = await waitForUsableKeyBeforePlay(
          session.player,
          8_000,
          session.wisePlayExpectedKids,
          operation.controller.signal,
          () => operations.get(video) === operation && active.get(video) === session,
        );
        report(operation, "wiseplay.key-before-play", {
          usableBeforePlay: keyReadiness.usable,
          waitTimeoutMs: 8_000,
          manifestKeyCount: session.wisePlayExpectedKids.length,
          reportedKeyCount: keyReadiness.reportedKeyCount,
          matchedManifestKeyCount: keyReadiness.matchedManifestKeyCount,
          globalKeyStatus: keyReadiness.globalKeyStatus,
          explicitManifestFailure: keyReadiness.explicitManifestFailure,
        }, keyReadiness.usable ? "info" : "warning");
        if (!keyReadiness.usable) {
          const error = new Error("The WisePlay license did not make every manifest key usable before playback.");
          error.code = "wiseplay_key_timeout";
          throw error;
        }
      }
      let requiresUserPlay = false;
      const playAttempt = Promise.race([video.play(), startupFailure]);
      const guardedPlayAttempt = selection.drmSystem === "playready"
        ? withPlaybackStartupTimeout(
            playAttempt,
            PLAYREADY_STARTUP_TIMEOUT_MS,
            operation.controller.signal,
            () => operations.get(video) === operation && active.get(video) === session,
          )
        : startupStage(playAttempt, operation, 30_000, "media_start_timeout",
            "Protected playback did not start. Please try again.");
      try { await guardedPlayAttempt; } catch (error) {
        if (error?.name !== "NotAllowedError") throw error;
        requiresUserPlay = true;
      }
      assertCurrentOperation(operation);
      session.startupPending = false;
      operations.delete(video);
      const result = {
        ...tracks,
        drmSystem: selection.drmSystem,
        keySystem: selection.keySystem,
        playbackPath: session.nativeFairPlay ? "fairplay-native-hls" : "mse-eme",
        requiresUserPlay,
        attemptId: operation.attemptId,
        playerBranding: session.playerBranding || null,
      };
      report(operation, "player.ready", {
        drmSystem: result.drmSystem,
        keySystem: result.keySystem,
        playbackPath: result.playbackPath,
        requiresUserPlay,
      });
      emit(video, "drmxready", result);
      return result;
    } catch (error) {
      if (operations.get(video) !== operation) {
        if (session) void release(session);
        void flushLogs(operation, true);
        throw playbackReplacedError();
      }
      if (error?.code === "media_start_timeout" && session) {
        error.data = [{
          keyStatuses: session.keyStatuses || [],
          readyState: Number(video.readyState || 0),
          currentTime: Number(video.currentTime || 0),
          videoHeight: Number(video.videoHeight || 0),
          startupMaximumHeight: session.startupMaximumHeight,
        }];
      }
      report(operation, "player.failed", errorDetails(error), error?.name === "AbortError" ? "debug" : "error");
      if (selection?.drmSystem === "playready"
          && drmSystem === "auto"
          && _playReadyFallback === 0
          && error?.code === "playready_startup_timeout"
          && operations.get(video) === operation) {
        report(operation, "playready.widevine-fallback", {
          reason: "licensed_media_did_not_advance",
          retry: 1,
          maximumRetries: 1,
        }, "warning");
        await dispose(video, Boolean(session), "playready-widevine-fallback");
        if (operations.get(video) !== operation) throw playbackReplacedError();
        operations.delete(video);
        void flushLogs(operation, true);
        return start({
          video,
          contentId: selectedContentId,
          contentType,
          drmSystem: "widevine",
          sessionEndpoint,
          logEndpoint,
          platformCapabilities: additionalCapabilities,
          adTagUrl,
          adContainer,
          startPosition,
          _playReadyFallback: 1,
        });
      }
      if (selection?.drmSystem === "widevine"
          && _widevineAuthenticationRetry === 0
          && isWidevineSessionAuthenticationFailure(error)
          && operations.get(video) === operation) {
        report(operation, "widevine.session-retry", {
          reason: "session_authentication_failed",
          retry: 1,
          maximumRetries: 1,
        }, "warning");
        await dispose(video, Boolean(session), "widevine-cdm-authentication-retry");
        if (operations.get(video) !== operation) throw playbackReplacedError();
        operations.delete(video);
        void flushLogs(operation, true);
        return start({
          video,
          contentId: selectedContentId,
          contentType,
          drmSystem: "widevine",
          sessionEndpoint,
          logEndpoint,
          platformCapabilities: additionalCapabilities,
          adTagUrl,
          adContainer,
          startPosition,
          _widevineAuthenticationRetry: 1,
        });
      }
      if (selection?.drmSystem === "widevine"
          && isWidevineSessionAuthenticationFailure(error)) {
        error = widevineAuthenticationError();
      }
      emit(video, "drmxerror", { code: error?.code || "playback_failed", message: error?.message || "Playback failed." });
      if (session && active.get(video) !== session) void release(session);
      else if (session) {
        try { await dispose(video, true, "startup-error"); }
        catch (cleanupError) { report(operation, "player.cleanup-failed", errorDetails(cleanupError), "warning"); }
      }
      if (operations.get(video) === operation) operations.delete(video);
      void flushLogs(operation, true);
      throw error;
    }
  }

  async function stop(video, reason = "stop") {
    ensureVideo(video);
    operations.get(video)?.controller.abort();
    operations.delete(video);
    await dispose(video, true, reason);
    emit(video, "drmxstopped", { reason });
  }

  function safePlayerUrl(value) {
    if(typeof value !== 'string' || !value.startsWith('https://'))return null;
    try { const url = new URL(String(value), global.location?.href || 'https://invalid.example'); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function normalizePlaylistItem(item) {
    if (!item || typeof item.contentId !== 'string' || !item.contentId.trim() || item.contentId.length > 200) throw new TypeError('Every playlist item needs a Content ID of at most 200 characters.');
    const text=value=>String(value||'').slice(0,300);
    const chapters=(Array.isArray(item.chapters)?item.chapters:[]).slice(0,500).filter(c=>Number.isFinite(c.start)&&c.start>=0).map(c=>({start:c.start,title:text(c.title),thumbnail:safePlayerUrl(c.thumbnail)})).sort((a,b)=>a.start-b.start);
    const transcript=(Array.isArray(item.transcript)?item.transcript:[]).slice(0,10000).filter(c=>Number.isFinite(c.start)&&c.start>=0).map(c=>({start:c.start,text:String(c.text||'').slice(0,2000)})).sort((a,b)=>a.start-b.start);
    return {contentId:item.contentId.trim(),title:text(item.title)||item.contentId,contentType:item.contentType==='live'?'live':'vod',poster:safePlayerUrl(item.poster),duration:Number.isFinite(item.duration)&&item.duration>0?item.duration:null,chapters,transcript};
  }
  class UniversalPlaylist {
    constructor(items=[],index=0) {
      if(!Array.isArray(items)||items.length>500)throw new TypeError('A playlist accepts up to 500 items.');
      this.items=items.map(normalizePlaylistItem);this.index=Math.max(0,Math.min(this.items.length-1,Number.isInteger(index)?index:0));this.repeat='off';this.shuffle=false;this.history=[];this.order=this.items.map((_,i)=>i);
    }
    select(index){if(!Number.isInteger(index)||!this.items[index])throw new RangeError('Invalid playlist index.');if(this.index!==index&&!this.fromHistory)this.history.push(this.index);this.history=this.history.slice(-500);this.fromHistory=false;this.index=index;}
    setShuffle(enabled){this.shuffle=Boolean(enabled);this.order=this.items.map((_,i)=>i);if(this.shuffle){this.order=this.order.filter(i=>i!==this.index);for(let i=this.order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[this.order[i],this.order[j]]=[this.order[j],this.order[i]];}this.order.unshift(this.index);}}
    peekNext(ended=false){if(!this.items.length)return null;if(ended&&this.repeat==='one')return this.index;const p=this.order.indexOf(this.index);return this.order[p+1]??(this.repeat==='all'?this.order[0]:null);}
    previous(){if(!this.items.length)return null;if(this.history.length){this.fromHistory=true;return this.history.pop();}const p=this.order.indexOf(this.index);return this.order[p-1]??(this.repeat==='all'?this.order.at(-1):null);}
  }
  function controlIcon(name) {
    const paths={'menu-back':'<path d="m14 6-6 6 6 6"/>',play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',volume:'<path d="m11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',muted:'<path d="m11 5-6 4H2v6h3l6 4ZM16 9l6 6m0-6-6 6"/>',settings:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.7"/><path d="M12 2v3" transform="rotate(0 12 12)"/><path d="M12 2v3" transform="rotate(45 12 12)"/><path d="M12 2v3" transform="rotate(90 12 12)"/><path d="M12 2v3" transform="rotate(135 12 12)"/><path d="M12 2v3" transform="rotate(180 12 12)"/><path d="M12 2v3" transform="rotate(225 12 12)"/><path d="M12 2v3" transform="rotate(270 12 12)"/><path d="M12 2v3" transform="rotate(315 12 12)"/>',fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',pip:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 12h7v6h-7Z"/>',theater:'<rect x="2" y="5" width="20" height="14" rx="2"/>',previous:'<path d="M5 5v14M19 5 8 12l11 7Z"/>',next:'<path d="M19 5v14M5 5l11 7-11 7Z"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',back:'<path d="M3 10a9 9 0 1 1 2 9M3 4v6h6"/><text x="8" y="16" font-size="8" fill="currentColor" stroke="none">10</text>',forward:'<path d="M21 10a9 9 0 1 0-2 9M21 4v6h-6"/><text x="8" y="16" font-size="8" fill="currentColor" stroke="none">10</text>',shuffle:'<path d="m18 3 4 4-4 4M2 17h3c5 0 8-10 13-10h4M2 7h3c2 0 4 2 5 4m4 3c1 2 3 3 5 3h3m-4-4 4 4-4 4"/>',repeat:'<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>','repeat-one':'<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3m8-8 2-1v6"/>'};
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.play}</svg>`;
  }
  const DEFAULT_PLAYER_LOGO = 'data:image/png;base64,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';

  const api = Object.freeze({
    Playlist: UniversalPlaylist,
    attachControls(video, adapter) {
      const parent=video.parentNode;
      if(!parent)throw new Error('Attach the video to its host before installing controls.');
      const marker=global.document.createComment('drmx-video');parent.insertBefore(marker,video);
      const controls=global.document.createElement('drmx-universal-player');
      controls.externalVideo=video;controls.adapter=adapter;parent.insertBefore(controls,video);
      return {element:controls,destroy(){if(marker.parentNode){marker.parentNode.insertBefore(video,marker);marker.remove();}controls.remove();video.controls=true;}};
    },
    version: SDK_VERSION,
    contractVersion: CONTRACT_VERSION,
    preferredDrm,
    selectDrm,
    platformCapabilities,
    reportingContext,
    start,
    stop,
    getTracks,
    getAudioTracks: (video) => getAudioTracks(video).map(({ _track, ...track }) => track),
    getSubtitleTracks: (video) => getSubtitleTracks(video).map(({ _track, ...track }) => track),
    getQualityOptions,
    selectAudioTrack,
    selectAudioLanguage,
    selectSubtitleTrack,
    selectSubtitleLanguage,
    hideSubtitles,
    selectQuality,
  });
  global.DrmXUniversalPlayer = api;
  global.DrmXPlayback = api;

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return "0:00";
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = Math.floor(value % 60);
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  if (global.customElements && global.HTMLElement && !global.customElements.get("drmx-universal-player")) {
    class DrmXUniversalPlayerElement extends global.HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) {
          if(this.uiAbort?.signal.aborted){this.bindUniversalEvents();global.document?.addEventListener?.("pointerdown",this.closeProtectionInfo);this.showUi();}
          return;
        }
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `
          <style>
            :host{display:block;color:#eaf2ff;font:14px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;--accent:#2f80ff;--panel:rgba(7,18,35,.94)}
            *{box-sizing:border-box}.stage{position:relative;overflow:hidden;aspect-ratio:16/9;background:#030a14;border-radius:0;box-shadow:0 20px 50px rgba(3,17,36,.28);outline:none}
            video{display:block;width:100%;height:100%;object-fit:contain;background:#030a14}video::cue{color:#fff;background:rgba(0,0,0,.74);font:600 clamp(16px,2vw,24px)/1.25 Inter,ui-sans-serif,system-ui,sans-serif;text-shadow:0 1px 3px #000}.ad{position:absolute;inset:0;z-index:4;pointer-events:auto}.ad:empty{display:none}
            .shade{position:absolute;inset:auto 0 0;padding:70px 18px 14px;background:linear-gradient(transparent,rgba(0,0,0,.84));opacity:1;transition:opacity .2s;z-index:6}
            .center{position:absolute;inset:0;display:grid;place-items:center;border:0;background:transparent;color:white;z-index:3;cursor:pointer}.center span{display:grid;place-items:center;width:72px;height:72px;border-radius:50%;background:rgba(8,25,48,.78);font-size:30px;box-shadow:0 8px 30px rgba(0,0,0,.4)}.stage.playing .center{display:none}
            .timeline-wrap{display:flex;align-items:center;width:100%;height:44px;margin:-13px 0 -7px}.timeline{width:100%;height:44px;margin:0;accent-color:var(--accent);cursor:pointer;touch-action:none}.row{display:flex;align-items:center;gap:10px;min-width:0}.row button{flex:0 0 auto}
            button,select{font:inherit;color:inherit}button.icon{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;font-size:18px}button.icon:hover,button.icon:focus-visible{background:rgba(255,255,255,.16);outline:none}
            .time{font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}.spacer{flex:1}.volume{width:76px;accent-color:white}
            .settings{position:absolute;right:14px;bottom:68px;z-index:9;width:min(390px,calc(100% - 28px));padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:var(--panel);box-shadow:0 18px 50px rgba(0,0,0,.5);backdrop-filter:none}.settings[hidden]{display:none}.settings label{display:grid;grid-template-columns:100px 1fr;align-items:center;gap:10px;margin:9px 0;color:#bcd0ea}.settings select{min-width:0;width:100%;padding:8px 10px;border:1px solid #3a4c64;border-radius:9px;background:#10243d}.settings-actions{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:8px;margin-top:8px}.settings-actions button{min-width:0;min-height:42px;padding:9px 10px;border:0;border-radius:9px;background:#243951;color:#eaf2ff;cursor:pointer}.settings-actions button:hover,.settings-actions button:focus-visible{background:#304a68;outline:2px solid rgba(112,171,255,.72);outline-offset:1px}
            .protection-info{position:absolute;z-index:12;max-width:calc(100% - 16px);padding:10px 13px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(7,18,35,.97);box-shadow:0 12px 32px rgba(0,0,0,.48)}.protection-info[hidden]{display:none}.protection-info a{color:#dcecff;text-decoration:none;white-space:nowrap}.protection-info a:hover,.protection-info a:focus-visible{color:#fff;text-decoration:underline;outline:none}
            .status{margin:9px 2px 0;min-height:1.4em;color:#52657e;font-size:13px}.spinner{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px;border:4px solid rgba(255,255,255,.22);border-top-color:white;border-radius:50%;animation:spin .8s linear infinite;z-index:8}.spinner[hidden]{display:none}@keyframes spin{to{transform:rotate(360deg)}}
            @media(max-width:620px){video::cue{font-size:16px}.volume{display:none}.time .total{display:none}.shade{padding-inline:10px}.row{gap:4px}.settings{right:8px;bottom:58px}}
            @media(hover:none),(pointer:coarse){.timeline-wrap,.timeline{height:52px}.timeline-wrap{margin:-17px 0 -9px}}
          </style>
          <div class="stage" tabindex="0" part="stage">
            <video playsinline preload="auto" part="video"></video><div class="ad" part="ad-container"></div>
            <div class="spinner" hidden aria-label="Loading"></div><button class="center" type="button" aria-label="Play"><span>▶</span></button>
            <div class="shade" part="controls"><div class="timeline-wrap"><input class="timeline" type="range" min="0" max="1000" value="0" aria-label="Seek"></div><div class="row">
              <button class="icon toggle" type="button" aria-label="Play">▶</button><button class="icon mute" type="button" aria-label="Mute">🔊</button><input class="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
              <span class="time"><span class="current">0:00</span> / <span class="total">0:00</span></span><span class="spacer"></span>
              <button class="icon pip" type="button" aria-label="Picture in picture">▣</button><button class="icon gear" type="button" aria-label="Playback settings" aria-expanded="false">⚙</button><button class="icon full" type="button" aria-label="Fullscreen">⛶</button>
            </div></div>
            <div class="settings" hidden><label>Quality<select class="quality"><option value="auto">Auto</option></select></label><label>Audio<select class="audio"><option value="">Default</option></select></label><label>Subtitles<select class="subtitles"><option value="off">Off</option></select></label><label>Speed<select class="speed"><option>.5</option><option>.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select></label><div class="settings-actions"><button class="stop" type="button">Stop and release session</button><button class="close-settings" type="button">Close Setting Window</button></div></div>
            <div class="protection-info" hidden></div>
          </div><div class="status" role="status" aria-live="polite">Ready.</div>`;
        this.video = root.querySelector("video");
        if(this.externalVideo){this.video.replaceWith(this.externalVideo);this.video=this.externalVideo;this.video.controls=false;this.video.setAttribute('part','video');}
        this.stage = root.querySelector(".stage");
        this.status = root.querySelector(".status");
        this.spinner = root.querySelector(".spinner");
        this.settings = root.querySelector(".settings");
        this.quality = root.querySelector(".quality");
        this.audio = root.querySelector(".audio");
        this.subtitles = root.querySelector(".subtitles");
        this.timeline = root.querySelector(".timeline");
        this.current = root.querySelector(".current");
        this.total = root.querySelector(".total");
        this.toggle = root.querySelector(".toggle");
        this.mute = root.querySelector(".mute");
        this.volume = root.querySelector(".volume");
        this.protectionInfo = root.querySelector(".protection-info");
        this.gear = root.querySelector(".gear");
        const poster = this.getAttribute("poster");
        if (poster) this.video.poster = poster;

        root.querySelector(".center").addEventListener("click", () => this.togglePlayback());
        this.toggle.addEventListener("click", () => this.togglePlayback());
        this.gear.addEventListener("click", (event) => {
          event.stopPropagation(); this.settings.hidden = !this.settings.hidden;
          this.gear.setAttribute("aria-expanded", String(!this.settings.hidden));
        });
        root.querySelector(".stop").addEventListener("click", () => this.stop());
        root.querySelector(".close-settings").addEventListener("click", () => this.closeSettings(true));
        root.querySelector(".full").addEventListener("click", () => { void this.toggleFullscreen(); });
        root.querySelector(".pip").addEventListener("click", async () => {
          try { if(global.document?.pictureInPictureElement) await global.document.exitPictureInPicture?.(); else await this.video.requestPictureInPicture?.(); }
          catch { this.announce('Picture in picture is unavailable for this playback.'); }
        });
        this.mute.addEventListener("click", () => { this.video.muted = !this.video.muted; this.updateMediaUi(); });
        this.volume.addEventListener("input", () => { this.video.volume = Number(this.volume.value); this.video.muted = false; });
        this.timeline.addEventListener("input", () => {
          if (!this.queue && Number.isFinite(this.video.duration)) this.video.currentTime = (Number(this.timeline.value) / 1000) * this.video.duration;
        });
        this.quality.addEventListener("change", () => { this.controlApi.selectQuality(this.video, this.quality.value); });
        this.audio.addEventListener("change", () => { if (this.audio.value) this.controlApi.selectAudioTrack(this.video, this.audio.value); });
        this.subtitles.addEventListener("change", () => {
          if (this.subtitles.value === "off") this.controlApi.hideSubtitles(this.video);
          else this.controlApi.selectSubtitleTrack(this.video, this.subtitles.value);
        });
        root.querySelector(".speed").addEventListener("change", (event) => { this.video.playbackRate = Number(event.target.value); });
        for (const event of ["timeupdate", "durationchange", "volumechange", "play", "pause", "ended"]) this.video.addEventListener(event, () => this.updateMediaUi());
        this.video.addEventListener("waiting", () => { this.spinner.hidden = false; });
        this.video.addEventListener("playing", () => { this.spinner.hidden = true; });
        this.video.addEventListener("drmxtracks", (event) => this.populateSettings(event.detail));
        this.video.addEventListener("drmxqualitychange", () => this.populateSettings(this.controlApi.getTracks(this.video)));
        this.video.addEventListener("drmxad", (event) => { this.status.textContent = event.detail?.status === "started" ? "Advertisement" : "Protected playback"; });
        this.stage.addEventListener("keydown", (event) => this.handleKey(event));
        this.stage.addEventListener("contextmenu", (event) => this.showProtectionInfo(event));
        this.closeProtectionInfo = (event) => {
          if (!event?.composedPath?.().includes(this.protectionInfo)) this.protectionInfo.hidden = true;
        };
        global.document?.addEventListener?.("pointerdown", this.closeProtectionInfo);
        this.installUniversalUi();
      }

      installUniversalUi() {
        const root = this.shadowRoot;
        this.controlApi = this.adapter || api;
        this.uiAbort = new global.AbortController();
        this.uiTimers = new Set();
        this.queue = this.queue || new UniversalPlaylist();
        this.autoNext = true;
        this.preferenceKey = 'drmx-universal-preferences-v1';
        try { this.preferences = JSON.parse(global.localStorage.getItem(this.preferenceKey)) || {}; if(typeof this.preferences!=='object'||Array.isArray(this.preferences))this.preferences={}; } catch { this.preferences = {}; }
        this.video.volume = Math.max(0, Math.min(1, Number.isFinite(Number(this.preferences.volume)) ? Number(this.preferences.volume) : 1));
        this.video.playbackRate = [.25,.5,.75,1,1.25,1.5,1.75,2].includes(this.preferences.speed) ? this.preferences.speed : 1;
        this.bookmarks = [];
        this.chapters = [];
        this.transcript = [];
        this.menuPage = 'main';
        const style = global.document.createElement('style');
        style.textContent = `
          :host{--accent:#7294ff;--panel:rgba(20,20,22,.8);color:#eef2ff;font:14px/1.45 Inter,system-ui,sans-serif;container-type:inline-size}
          [hidden]{display:none!important}*{box-sizing:border-box}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #bdd0ff!important;outline-offset:2px}
          button.icon{width:40px;height:40px;border-radius:50%;font-size:16px}button svg{width:21px;height:21px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
          .stage{width:100%;min-width:0;border-radius:0;outline:revert;min-height:220px}.stage.theater{aspect-ratio:21/9}.stage:fullscreen{width:100%;height:100%;aspect-ratio:auto;border-radius:0}
          .row{gap:3px}.time{font-size:12px}.volume{width:66px}.center span{width:56px;height:56px;font-size:22px}.center svg{width:26px;height:26px}
          .settings{width:310px;max-height:calc(100% - 90px);padding:0;overflow:auto;overscroll-behavior:contain;background:var(--panel);border-radius:14px;backdrop-filter:none}
          .menu-head{display:flex;align-items:center;gap:5px;position:sticky;top:0;background:rgba(20,20,22,.55);padding:6px 9px;border-bottom:1px solid #ffffff18;z-index:1}.menu-head strong{flex:1;font-weight:500}.menu-body{padding:5px 0}
          .menu-row{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;border:0;padding:10px 16px;min-height:44px;background:transparent;text-align:left;cursor:pointer;color:inherit}.menu-row:hover,.menu-row[aria-pressed=true]{background:#ffffff0c}.menu-row small,.menu-value{color:#b9c4d8;font-size:12px}.menu-row small{display:block}.menu-row:disabled{opacity:.5;cursor:default}.menu-value{text-align:right;max-width:55%;overflow-wrap:anywhere}.menu-note{font-size:12px;color:#b9c4d8;padding:10px 16px;margin:0}
          .menu-body label{display:flex;justify-content:space-between;gap:12px;padding:5px 16px;margin:5px 0;font-size:13px}.menu-body select{max-width:57%;background:#263247}.menu-body input{min-width:0;max-width:100%;padding:9px;background:#263247;color:white;border:1px solid #58687f;border-radius:6px}
          .top-line{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:14px;background:linear-gradient(#0009,transparent);z-index:2;pointer-events:none}.video-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.player-brand{display:flex;align-items:center;gap:5px;font-size:12px;flex-shrink:0;pointer-events:none}.player-brand img{max-width:90px;height:30px;object-fit:contain}.brand-label{max-width:130px;overflow:hidden;text-overflow:ellipsis}
          button.icon.skip-touch{position:absolute;top:44%;z-index:4;display:none;background:#07132499!important;border-radius:50%!important}.skip-touch.back{left:20%}.skip-touch.forward{right:20%}
          .cc.active{color:var(--accent);text-decoration:underline;text-underline-offset:6px}.live-edge{font-size:12px;background:#ae2035;border:0;border-radius:5px;padding:7px;color:white;white-space:nowrap;cursor:pointer}
          .timeline-wrap{position:relative;background:transparent}.timeline{appearance:none;z-index:2;background:transparent;height:36px}.timeline::-webkit-slider-runnable-track{height:4px;background:transparent}.timeline::-webkit-slider-thumb{appearance:none;background:var(--accent);width:12px;height:12px;border-radius:50%;margin-top:-4px}.timeline::-moz-range-track{background:transparent}.timeline::-moz-range-thumb{background:var(--accent);border:0;width:12px;height:12px}
          .progress-track{position:absolute;left:0;right:0;height:4px;background:#ffffff45;overflow:hidden;pointer-events:none}.buffer-fill,.played-fill{position:absolute;inset:0 auto 0 0;background:#ffffff60}.played-fill{background:var(--accent)}.chapter-marks{position:absolute;inset:0}.chapter-marks i{position:absolute;height:4px;width:3px;background:#071221}
          .seek-preview{position:absolute;bottom:32px;left:0;min-width:100px;max-width:175px;background:#1c2331;padding:6px;border:1px solid #ffffff30;border-radius:7px;text-align:center;font-size:12px;pointer-events:none;z-index:3}.seek-preview img{display:block;width:100%;max-height:85px;object-fit:cover;border-radius:4px}.seek-preview span{display:block}
          .notice{position:absolute;left:50%;top:18%;transform:translateX(-50%);background:#101b2eee;padding:8px 12px;border-radius:8px;z-index:12;max-width:90%;text-align:center;font-size:13px}.next-overlay{position:absolute;inset:auto 15px 85px auto;background:#1c2331;padding:14px;border-radius:12px;z-index:8;width:min(300px,calc(100% - 30px))}.next-overlay strong{display:block}.next-overlay button{background:#354663;border:0;border-radius:6px;padding:8px 12px;margin:8px 6px 0 0;cursor:pointer}
          .notice button{appearance:none;-webkit-appearance:none;background:#263b61;color:#fff;border:1px solid #91adf0;border-radius:6px;padding:9px 14px;min-height:44px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}.notice button:hover{background:#344e7d}
          .drawer{margin-top:12px;border:1px solid #c5cee04d;border-radius:12px;background:#141d2c;color:#f2f5ff;overflow:hidden}.drawer-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #ffffff18;flex-wrap:wrap}.drawer-head strong{flex:1;font-weight:500}.queue-list{max-height:310px;overflow:auto}.queue-item{display:flex;gap:10px;align-items:center;width:100%;padding:10px 14px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;min-height:52px}.queue-item:hover,.queue-item[aria-current=true]{background:#7294ff25}.queue-item img{width:74px;height:42px;object-fit:cover;border-radius:5px}.queue-item span{min-width:0;overflow-wrap:anywhere}.queue-item small{color:#aebbd0;display:block}.queue-index{font-variant-numeric:tabular-nums;width:22px;flex-shrink:0}.drawer-head button{color:inherit}.drawer-head label{display:flex;gap:6px;align-items:center;font-size:12px}.drawer-head input{accent-color:var(--accent)}
          .status{color:#60718b;font-size:12px}.stage.controls-hidden.playing .shade,.stage.controls-hidden.playing .top-line,.stage.controls-hidden.playing .skip-touch{opacity:0;pointer-events:none}.stage.controls-hidden.playing{cursor:none}@media(prefers-reduced-motion:reduce){.shade,.top-line{transition:none}}
          video::cue{font-family:var(--caption-font,system-ui);font-size:var(--caption-size,20px);color:var(--caption-color,#fff);background:var(--caption-bg,#000c)}
          @container(max-width:600px){.volume,.pip,.theater-button,.previous,.next{display:none!important}.time .total{display:none}.shade{padding-inline:8px}.row{gap:0}.row button.icon{width:40px;height:40px}.settings{width:calc(100% - 16px);right:8px;bottom:64px;max-height:calc(100% - 76px)}.skip-touch{display:grid!important}.stage:has(.settings:not([hidden])){min-height:390px}.video-title{max-width:100%}.stage{aspect-ratio:16/10}.drawer-head{padding:8px}.time{font-size:12px}}
          @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
        `;
        root.append(style);
        const button = (action,label,name,extra='') => `<button type="button" class="icon ${extra}" data-action="${action}" aria-label="${label}" title="${label}">${controlIcon(name)}</button>`;
        const row = root.querySelector('.row');
        row.querySelector('.toggle').innerHTML = controlIcon('play');
        row.querySelector('.mute').innerHTML = controlIcon('volume');
        row.querySelector('.gear').innerHTML = controlIcon('settings');
        row.querySelector('.full').innerHTML = controlIcon('fullscreen');
        row.querySelector('.pip').innerHTML = controlIcon('pip');
        row.querySelector('.pip').hidden = !global.document.pictureInPictureEnabled || !this.video.requestPictureInPicture;
        row.querySelector('.toggle').insertAdjacentHTML('afterend',button('previous','Previous video (Shift+P)','previous','previous')+button('next','Next video (Shift+N)','next','next'));
        row.querySelector('.gear').insertAdjacentHTML('beforebegin','<button class="icon cc" data-action="cc" type="button" aria-label="Captions (C)" hidden>CC</button>');
        row.querySelector('.full').insertAdjacentHTML('beforebegin',button('theater','Theater mode (T)','theater','theater-button'));
        row.querySelector('.spacer').insertAdjacentHTML('beforebegin','<button class="live-edge" data-action="live" type="button" hidden>Go live</button>');
        this.stage.insertAdjacentHTML('afterbegin','<div class="top-line"><span class="video-title"></span></div>');
        this.stage.insertAdjacentHTML('beforeend',button('back','Back 10 seconds (J)','back','skip-touch back')+button('forward','Forward 10 seconds (L)','forward','skip-touch forward')+'<div class="notice" role="status" hidden></div><div class="next-overlay" hidden><span class="countdown"></span><strong class="next-title"></strong><button type="button" data-action="next">Play now</button><button type="button" data-action="cancel-next">Cancel</button></div>');
        this.settings.innerHTML = '<div class="menu-head"><button class="icon menu-back" data-action="menu-back" aria-label="Back" type="button">'+controlIcon('menu-back')+'</button><strong>Settings</strong><button class="icon" data-action="close-menu" aria-label="Close settings" type="button">'+controlIcon('close')+'</button></div><div class="menu-body"></div>';
        root.querySelector('.timeline-wrap').insertAdjacentHTML('afterbegin','<div class="progress-track"><div class="buffer-fill"></div><div class="played-fill"></div><div class="chapter-marks"></div></div><div class="seek-preview" hidden><img alt="" hidden><span></span></div>');
        this.stage.insertAdjacentHTML('afterend','<section class="drawer" aria-label="Playlist" hidden><div class="drawer-head"><strong>Playlist</strong><span class="queue-count"></span>'+button('shuffle','Shuffle','shuffle')+button('repeat','Repeat off','repeat')+'<label><input class="auto-next" type="checkbox" checked>Play next</label></div><div class="queue-list"></div></section>');
        this.protectionInfo.setAttribute('role','dialog');
        this.protectionInfo.setAttribute('aria-label','About player');
        this.protectionInfo.innerHTML = '<div class="about-content"></div><button type="button" class="menu-row" data-action="context-info">Playback information ›</button><button type="button" class="menu-row" data-action="close-about">Close</button>';
        style.textContent += '.protection-info{width:290px;padding:8px;max-height:calc(100% - 16px);overflow:auto}.about-content{padding:12px}.about-content p{margin:8px 0;color:#b9c4d8;font-size:12px}.about-content a{color:#dcecff}.about-content .player-brand{pointer-events:auto;margin-bottom:14px;gap:10px}.about-content .brand-label{display:block;max-width:180px}.about-content .player-brand img{height:32px}.about-content strong{display:block;font-size:14px;font-weight:500}.about-content small{color:#b9c4d8}.top-line{transition:opacity .15s}';
        this.defaultLogo = DEFAULT_PLAYER_LOGO;
        this.applyBranding(null);
        this.bindUniversalEvents();
        this.applyCaptionPreferences();
        this.refreshUniversalUi();
        this.showUi();
        if(this._pendingPlaylist){const pending=this._pendingPlaylist;this._pendingPlaylist=null;this.setPlaylist(pending.items,pending.options);}
      }

      bindUniversalEvents() {
        const root=this.shadowRoot;this.uiAbort=new global.AbortController();
        const listen=(target,event,fn)=>target.addEventListener(event,fn,{signal:this.uiAbort.signal});
        listen(root,'click',event=>{const target=event.target.closest('[data-action],[data-menu],[data-choice],[data-index],[data-seek]');if(!target)return;event.stopPropagation();Promise.resolve(this.uiAction(target)).catch(()=>this.announce('That action is unavailable.'));});
        listen(this.gear,'click',()=>{this.menuPage='main';this.renderMenu();this.showUi();});
        listen(root,'change',event=>{if(event.target.matches('.auto-next')){this.autoNext=event.target.checked;if(!this.autoNext)this.cancelNext();}if(event.target.dataset.preference){this.preferences[event.target.dataset.preference]=event.target.value;this.savePreferences();this.applyCaptionPreferences();}});
        const pointerActivity=()=>{this.keyboardUi=false;this.showUi();};
        listen(this.stage,'pointerenter',event=>{if(event.pointerType!=='touch')pointerActivity();});
        listen(this.stage,'pointermove',event=>{
          const point=[event.clientX,event.clientY];
          if(this.surfaceGesture&&Math.hypot(point[0]-this.surfaceGesture.x,point[1]-this.surfaceGesture.y)>5)this.surfaceGesture.dragged=true;
          if(event.pointerType!=='touch'&&(!this.lastPointerPoint||point.some((n,i)=>n!==this.lastPointerPoint[i])))pointerActivity();
          this.lastPointerPoint=point;
        });
        listen(this.stage,'pointerdown',event=>{
          if(event.button!==0)return;
          this.surfaceGesture=this.isVideoSurface(event.target)?{hidden:this.stage.classList.contains('controls-hidden'),x:event.clientX,y:event.clientY}:null;
          this.lastPointerPoint=[event.clientX,event.clientY];this.pointerHeld=true;pointerActivity();
        });
        listen(global.document,'pointerup',()=>{if(this.pointerHeld){this.pointerHeld=false;this.showUi();}});
        listen(global.document,'pointercancel',()=>{this.surfaceGesture=null;this.pointerHeld=false;this.showUi();});
        listen(this.stage,'click',event=>this.handleSurfaceClick(event));
        listen(this.stage,'keydown',()=>{this.keyboardUi=true;this.showUi();});
        listen(this.stage,'focusin',()=>this.showUi());
        listen(this.stage,'focusout',()=>this.showUi());
        for(const event of ['play','playing','pause','ended','waiting','error'])listen(this.video,event,()=>this.showUi());
        listen(this.video,'dblclick',event=>{global.clearTimeout(this.videoClickTimer);if(global.matchMedia?.('(pointer:coarse)').matches){const r=this.video.getBoundingClientRect();this.seekBy(event.clientX-r.left<r.width/2?-10:10);}else void this.toggleFullscreen();});
        listen(this.video,'ended',()=>{this.saveResume(true);this.handleEnded();});
        listen(this.video,'pause',()=>this.saveResume(true));
        listen(global,'pagehide',()=>this.saveResume(true));
        listen(this.video,'drmxstopped',event=>{
          // A completed old release must not overwrite a newer authorization.
          if(active.has(this.video)||operations.has(this.video))return;
          this.loadedContentId=null;this.spinner.hidden=true;
          this.status.textContent=event.detail?.reason==='ended'?'Video ended.':'Playback stopped.';
          this.refreshUniversalUi();
        });
        listen(this.video,'drmxerror',event=>{this.cancelNext();this.spinner.hidden=true;this.status.textContent=event.detail?.message||'Playback failed. Try again.';});
        listen(this.video,'drmxprogress',event=>{
          const message=({'player.cleanup':'Closing the previous video…','drm.probe':'Checking protected playback support…','session.request':'Authorizing protected playback…','session.authorized':'Loading protected video…','manifest.load':'Loading protected video…','drm.license-request':'Getting the playback license…','drm.keys-ready':'Starting protected playback…','tracks.discovered':'Starting protected playback…'})[event.detail?.phase];
          if(message)this.status.textContent=message;
        });
        listen(this.video,'drmxselection',()=>{this.renderMenu();this.refreshUniversalUi();});
        listen(this.video,'ratechange',()=>this.savePreferences());
        listen(this.video,'volumechange',()=>this.savePreferences());
        listen(this.video,'timeupdate',()=>{this.refreshUniversalUi();this.saveResume();if(this.loopB!=null&&this.video.currentTime>=this.loopB)this.seekTo(this.loopA);});
        listen(this.timeline,'input',()=>this.seekTo(this.seekStart+Number(this.timeline.value)/1000*(this.seekEnd-this.seekStart)));
        listen(this.timeline,'pointermove',event=>this.previewSeek(event));
        listen(this.timeline,'pointerleave',()=>root.querySelector('.seek-preview').hidden=true);
        listen(root,'input',event=>{if(event.target.matches('.transcript-search'))this.renderTranscript(event.target.value);});
      }

      resumeStorageKey(){const scope=this.getAttribute('resume-key');const content=this.getAttribute('content-id');return scope&&content?'drmx-resume-v1:'+scope.slice(0,160)+':'+content:null;}
      saveResume(force=false){
        const key=this.resumeStorageKey();if(this.loadedContentId!==this.getAttribute('content-id')||!key||key!==this.loadedResumeKey||this.getAttribute('content-type')==='live')return;
        const v=this.video;if(!Number.isFinite(v.duration)||v.duration<=0)return;
        try {
          if(v.ended||v.currentTime>=v.duration-10){global.localStorage.removeItem(key);return;}
          if(!force&&Date.now()-(this.resumeWrittenAt||0)<5000)return;
          if(v.currentTime>0){global.localStorage.setItem(key,JSON.stringify({position:v.currentTime,updatedAt:Date.now()}));this.resumeWrittenAt=Date.now();}
          else global.localStorage.removeItem(key);
        }catch{}
      }
      readResume(){
        const key=this.resumeStorageKey();if(!key||this.getAttribute('content-type')==='live')return null;
        try {
          const saved=JSON.parse(global.localStorage.getItem(key));const age=Date.now()-saved?.updatedAt;
          if(saved&&Number.isFinite(saved.position)&&saved.position>0&&Number.isFinite(age)&&age>=0&&age<30*86400000)return saved.position;
        }catch{}
        return null;
      }

      savePreferences() {
        this.preferences.volume=this.video.volume;this.preferences.speed=this.video.playbackRate;
        try { global.localStorage.setItem(this.preferenceKey,JSON.stringify(this.preferences)); } catch { /* Storage is optional. */ }
      }
      applyCaptionPreferences() {
        this.stage.style.setProperty('--caption-size',({'small':'16px','medium':'20px','large':'26px'})[this.preferences.captionSize]||'20px');
        this.stage.style.setProperty('--caption-color',this.preferences.captionColor==='yellow'?'#ffed80':'#fff');
        this.stage.style.setProperty('--caption-bg',this.preferences.captionBackground==='transparent'?'transparent':'#000c');
      }
      isVideoSurface(target) {
        return target===this.video||target===this.stage||target?.matches?.('.shade,.top-line,.video-title');
      }
      handleSurfaceClick(event) {
        const gesture=this.surfaceGesture;this.surfaceGesture=null;
        if(!this.isVideoSurface(event.target)||gesture?.dragged)return;
        this.keyboardUi=false;
        const wasHidden=gesture?gesture.hidden:this.stage.classList.contains('controls-hidden');
        if(wasHidden)this.showUi();else this.hideUi();
      }
      hideUi() {
        const focused=this.shadowRoot.activeElement;
        const keyboardFocus=focused&&(this.keyboardUi===true||(this.keyboardUi===undefined&&focused.matches?.(':focus-visible')));
        if(!this.video.paused&&!this.video.ended&&!this.video.error&&this.spinner.hidden&&this.settings.hidden&&this.protectionInfo.hidden&&!this.pointerHeld&&!keyboardFocus){
          global.clearTimeout(this.hideUiTimer);this.stage.classList.add('controls-hidden');
        }
      }
      showUi() {
        this.stage.classList.remove('controls-hidden');global.clearTimeout(this.hideUiTimer);
        this.hideUiTimer=global.setTimeout(()=>this.hideUi(),3000);
      }
      announce(text) { const n=this.shadowRoot.querySelector('.notice');n.textContent=text;n.hidden=false;global.clearTimeout(this.noticeTimer);this.noticeTimer=global.setTimeout(()=>n.hidden=true,2200); }
      applyBranding(value) {
        this.branding = value;
        this.protectionInfo.querySelector('.about-content').innerHTML = this.aboutHtml();
        this.renderMenu();
      }
      aboutHtml() {
        const value=this.branding, mode=value?.canCustomize===true?value.mode:'default';
        const custom=mode==='custom', label=custom?String(value.label||'').slice(0,80):'DRM-X 6.0';
        const logo=custom&&safePlayerUrl(value.logoUrl)?value.logoUrl:this.defaultLogo;
        return (mode==='hidden'?'':`<div class="player-brand"><img alt="" referrerpolicy="no-referrer" src="${escapeHtml(logo)}"><span class="brand-label">${escapeHtml(label)}</span></div>`)+
          `<strong>Universal Player · Web</strong><p>Version ${SDK_VERSION}<br>Protected video playback</p><a href="https://www.drm-x.com/" target="_blank" rel="noopener noreferrer">Product information ↗</a>`;
      }
      setPlaylist(items, options={}) {
        if(!this.shadowRoot){this._pendingPlaylist={items,options};return;}
        const replacement=new UniversalPlaylist(items,options.startIndex||0);
        if(active.has(this.video)){this.playGeneration=(this.playGeneration||0)+1;void api.stop(this.video,'playlist-replaced');}
        this.cancelNext();this.queue=replacement;this.autoNext=options.autoNext!==false;
        this.shadowRoot.querySelector('.auto-next').checked=this.autoNext;
        if(this.queue.items.length){this.useItem(this.queue.index);}
        this.renderQueue();
      }
      get playlist(){return this.queue?.items.map(item=>({...item}))||this._pendingPlaylist?.items||[];}
      set playlist(items){this.setPlaylist(items);}
      useItem(index) {
        const item=this.queue.items[index];if(!item)return;
        this.saveResume(true);this.loadedContentId=null;this.resumeWrittenAt=0;
        this.shadowRoot.querySelector('.notice').hidden=true;
        this.setAttribute('content-id',item.contentId);this.setAttribute('content-type',item.contentType);
        this.setAttribute('title',item.title);this.video.poster=item.poster||'';
        this.chapters=item.chapters||[];this.transcript=item.transcript||[];this.bookmarks=[];this.loopA=null;this.loopB=null;
        this.refreshUniversalUi();this.renderQueue();
      }
      async playIndex(index) {
        if(!Number.isInteger(index)||index<0||index>=this.queue.items.length)return;
        this.cancelNext();this.queue.select(index);this.useItem(index);this.applyBranding(null);
        emit(this,'drmxplaylistchange',{index,contentId:this.queue.items[index].contentId,total:this.queue.items.length});
        await this.play();
      }
      async next(){const index=this.queue.peekNext(false);if(index!=null)await this.playIndex(index);}
      async previous(){const index=this.queue.previous();if(index!=null)await this.playIndex(index);}
      cancelNext(){global.clearInterval(this.nextTimer);this.nextTimer=null;this.shadowRoot?.querySelector('.next-overlay')?.setAttribute('hidden','');}
      handleEnded(){
        if(this.sleepAtEnd){this.sleepAtEnd=false;this.cancelNext();return;}
        if(this.queue.repeat==='one'){this.nextTimer=global.setTimeout(()=>void this.playIndex(this.queue.index),0);return;}
        const next=this.queue.peekNext(true);if(!this.autoNext||next==null)return;
        this.cancelNext();let seconds=5;const overlay=this.shadowRoot.querySelector('.next-overlay');overlay.hidden=false;overlay.querySelector('.next-title').textContent=this.queue.items[next].title;
        const tick=()=>overlay.querySelector('.countdown').textContent=`Up next in ${seconds} seconds`;tick();
        this.nextTimer=global.setInterval(()=>{seconds--;tick();if(seconds<=0){this.cancelNext();void this.playIndex(next);}},1000);
      }
      renderQueue(){
        const root=this.shadowRoot,items=this.queue.items;root.querySelector('.drawer').hidden=items.length<2;
        root.querySelector('.queue-count').textContent=items.length?`${this.queue.index+1} / ${items.length}`:'';
        root.querySelector('.queue-list').innerHTML=items.map((item,index)=>`<button type="button" class="queue-item" data-index="${index}" aria-current="${index===this.queue.index}"><span class="queue-index">${index===this.queue.index?'▶':index+1}</span>${item.poster?`<img src="${escapeHtml(item.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<span>${escapeHtml(item.title)}<small>${item.contentType==='live'?'LIVE':item.duration?formatTime(item.duration):''}</small></span></button>`).join('');
        root.querySelector('[data-action=shuffle]').setAttribute('aria-pressed',String(this.queue.shuffle));root.querySelector('[data-action=repeat]').setAttribute('aria-label',`Repeat ${this.queue.repeat}`);root.querySelector('[data-action=repeat]').title=`Repeat ${this.queue.repeat}`;
        root.querySelector('[data-action=repeat]').setAttribute('aria-pressed',String(this.queue.repeat!=='off'));root.querySelector('[data-action=repeat]').innerHTML=controlIcon(this.queue.repeat==='one'?'repeat-one':'repeat');
        root.querySelector('.previous').hidden=items.length<2;root.querySelector('.next').hidden=items.length<2;root.querySelector('.next').disabled=this.queue.peekNext(false)==null;
      }
      refreshUniversalUi(){
        if(!this.queue)return;const r=this.shadowRoot,v=this.video;this.stage.classList.toggle('playing',!v.paused&&!v.ended);this.toggle.setAttribute('aria-label',v.paused?'Play':'Pause');this.mute.setAttribute('aria-label',v.muted?'Unmute':'Mute');this.volume.value=String(v.volume);const player=active.get(v)?.player||this.adapter?.getPlayer?.();
        const live=this.getAttribute('content-type')==='live'||player?.isLive?.()===true;
        this.liveTimeline=live;
        const range=player?.seekRange?.(),validRange=Number.isFinite(range?.start)&&Number.isFinite(range?.end)&&range.end>range.start;
        const nativeLength=v.seekable.length,nativeStart=nativeLength?v.seekable.start(live?nativeLength-1:0):0,nativeEnd=nativeLength?v.seekable.end(nativeLength-1):0;
        this.seekStart=validRange?range.start:nativeStart;
        // Native live HLS can have a finite, absolute duration; use its DVR window.
        this.seekEnd=validRange?range.end:live?nativeEnd:Number.isFinite(v.duration)?v.duration:nativeEnd;
        this.current.textContent=this.formatTimelinePosition(v.currentTime);
        this.timeline.disabled=this.seekEnd<=this.seekStart;
        this.timeline.setAttribute('aria-valuetext',live?(this.current.textContent==='—'?'Live timing unavailable':this.current.textContent.replace('−','')+' behind live'):this.current.textContent+' of '+formatTime(v.duration));
        const ratio=t=>Math.max(0,Math.min(100,(t-this.seekStart)/(this.seekEnd-this.seekStart||1)*100));
        this.timeline.value=String(ratio(v.currentTime)*10);r.querySelector('.played-fill').style.width=ratio(v.currentTime)+'%';
        r.querySelector('.buffer-fill').style.width=ratio(v.buffered.length?v.buffered.end(v.buffered.length-1):0)+'%';
        r.querySelector('.chapter-marks').innerHTML=this.chapters.map(c=>`<i style="left:${ratio(c.start)}%"></i>`).join('');
        r.querySelector('.live-edge').hidden=!live;r.querySelector('.live-edge').disabled=this.timeline.disabled;r.querySelector('.live-edge').textContent=!this.timeline.disabled&&v.currentTime>=this.seekStart&&this.seekEnd-v.currentTime<4?'● LIVE':'Go live';this.total.textContent=live?'LIVE':formatTime(v.duration);
        r.querySelector('.video-title').textContent=this.getAttribute('title')||'Universal Player';
        this.toggle.innerHTML=controlIcon(!v.paused&&!v.ended?'pause':'play');r.querySelector('.center span').innerHTML=controlIcon('play');this.mute.innerHTML=controlIcon(v.muted||v.volume===0?'muted':'volume');
        const tracks=this.controlApi.getTracks(v);r.querySelector('.cc').hidden=!tracks.subtitleTracks.length;r.querySelector('.cc').classList.toggle('active',tracks.subtitleTracks.some(t=>t.active));
      }
      formatTimelinePosition(value){
        if(!this.liveTimeline)return formatTime(value);
        if(this.seekEnd<=this.seekStart||!Number.isFinite(value)||value<this.seekStart)return '—';
        const behind=Math.max(0,this.seekEnd-value);
        return (behind>=1?'−':'')+formatTime(behind);
      }
      seekTo(value){if(Number.isFinite(value)&&this.seekEnd>this.seekStart)this.video.currentTime=Math.max(this.seekStart,Math.min(this.seekEnd,value));}
      seekBy(seconds){this.seekTo(this.video.currentTime+seconds);this.announce(`${seconds>0?'+':''}${seconds} seconds`);}
      previewSeek(event){const rect=this.timeline.getBoundingClientRect(),box=this.shadowRoot.querySelector('.seek-preview');if(this.seekEnd<=this.seekStart||rect.width<=0){box.hidden=true;return;}const x=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));const time=this.seekStart+x*(this.seekEnd-this.seekStart);const chapter=[...this.chapters].reverse().find(c=>c.start<=time);box.hidden=false;box.style.left=Math.max(0,Math.min(rect.width-175,x*rect.width-80))+'px';box.querySelector('span').textContent=(this.liveTimeline?(this.seekEnd-time<4?'LIVE':this.formatTimelinePosition(time)+' · LIVE'):formatTime(time))+(chapter?' · '+chapter.title:'');const img=box.querySelector('img');img.hidden=!chapter?.thumbnail;if(chapter?.thumbnail)img.src=chapter.thumbnail;}
      renderMenu(){
        if(!this.queue||this.settings.hidden)return;const p=this.menuPage,t=this.controlApi.getTracks(this.video),v=this.video;const body=this.settings.querySelector('.menu-body');const focused=this.shadowRoot.activeElement,focusedChoice=focused?.dataset.choice,focusedField=focused?.dataset.field;
        const row=(label,value,target,disabled=false)=>`<button type="button" class="menu-row" data-menu="${target}" ${disabled?'disabled':''}><span>${escapeHtml(label)}</span><span class="menu-value">${escapeHtml(value)} ›</span></button>`;
        const choice=(label,value,field,selected=false)=>`<button type="button" class="menu-row" data-choice="${escapeHtml(value)}" data-field="${field}" aria-pressed="${selected}"><span>${escapeHtml(label)}</span><span>${selected?'✓':''}</span></button>`;
        this.settings.querySelector('strong').textContent=({main:'Settings',quality:'Quality',audio:'Audio track',captions:'Subtitles / CC',speed:'Playback speed',sleep:'Sleep timer',style:'Caption appearance',more:'More options',chapters:'Chapters',transcript:'Transcript',bookmarks:'Bookmarks',information:'Playback information',shortcuts:'Keyboard shortcuts',about:'About player',playlist:'Playlist'})[p]||'Settings';
        this.settings.querySelector('.menu-back').hidden=p==='main';let html='';
        if(p==='main')html=row('Quality',t.qualityMode==='auto'?`Auto${t.qualityOptions.find(x=>x.active)?.height?' ('+t.qualityOptions.find(x=>x.active).height+'p)':''}`:t.qualityMode+'p','quality',!t.qualityOptions.length)+row('Audio track',t.audioTracks.find(x=>x.active)?.label||'Default','audio',!t.audioTracks.length)+row('Subtitles / CC',t.subtitleTracks.find(x=>x.active)?.label||'Off','captions',!t.subtitleTracks.length)+row('Playback speed',v.playbackRate===1?'Normal':v.playbackRate+'×','speed')+row('Sleep timer',this.sleepDeadline?Math.ceil((this.sleepDeadline-Date.now())/60000)+' min':this.sleepAtEnd?'End of video':'Off','sleep')+row('About player','','about')+row('More options','','more');
        if(p==='quality')html=choice('Auto','auto','quality',t.qualityMode==='auto')+t.qualityOptions.map(x=>choice(x.height+'p'+(x.height>=2160?' · 4K':''),x.height,'quality',String(x.height)===t.qualityMode)).join('')+'<p class="menu-note">Only qualities permitted by this license and device are listed. Native HLS may manage quality automatically.</p>';
        if(p==='audio')html=t.audioTracks.map(x=>choice(x.label+(x.channelsCount?' · '+x.channelsCount+' ch':''),x.id,'audio',x.active)).join('');
        if(p==='captions')html=choice('Off','off','captions',!t.subtitleTracks.some(x=>x.active))+t.subtitleTracks.map(x=>choice(x.label,x.id,'captions',x.active)).join('')+row('Caption appearance','','style');
        if(p==='speed')html=[.25,.5,.75,1,1.25,1.5,1.75,2].map(x=>choice(x===1?'Normal':x+'×',x,'speed',v.playbackRate===x)).join('');
        if(p==='sleep')html=[0,5,15,30,45,60].map(x=>choice(x?x+' minutes':'Off',x,'sleep')).join('')+choice('End of video','end','sleep',this.sleepAtEnd);
        if(p==='style')html=[['Size','captionSize',['small','medium','large']],['Color','captionColor',['white','yellow']],['Background','captionBackground',['black','transparent']]].map(([label,key,options])=>`<label>${label}<select data-preference="${key}">${options.map(x=>`<option value="${x}" ${(this.preferences[key]||({captionSize:'medium',captionColor:'white',captionBackground:'black'})[key])===x?'selected':''}>${x}</option>`).join('')}</select></label>`).join('');
        if(p==='more')html=row('Playlist',String(this.queue.items.length),'playlist',!this.queue.items.length)+row('Chapters',String(this.chapters.length),'chapters',!this.chapters.length)+row('Transcript','','transcript',!this.transcript.length)+row('Bookmarks',String(this.bookmarks.length),'bookmarks')+`<button class="menu-row" type="button" data-action="ab">${this.loopB!=null?'Clear A–B loop':this.loopA!=null?'Set loop B':'Set loop A'}</button>`+row('Playback information','','information')+row('Keyboard shortcuts','','shortcuts')+'<button type="button" class="menu-row" data-action="stop">Stop playback</button>';
        if(p==='about')html='<div class="about-content">'+this.aboutHtml()+'</div>';
        if(p==='playlist')html=this.queue.items.map((item,index)=>`<button type="button" class="menu-row" data-index="${index}" aria-current="${index===this.queue.index}"><span>${index+1}. ${escapeHtml(item.title)}</span><span>${index===this.queue.index?'✓':''}</span></button>`).join('');
        if(p==='chapters')html=this.chapters.map(c=>`<button type="button" class="menu-row" data-seek="${c.start}"><span>${escapeHtml(c.title)}</span><span class="menu-value">${formatTime(c.start)}</span></button>`).join('');
        if(p==='transcript')html='<label><input class="transcript-search" aria-label="Search transcript" placeholder="Search transcript"></label><div class="transcript-results"></div>';
        if(p==='bookmarks')html='<button type="button" class="menu-row" data-action="bookmark">Bookmark '+formatTime(v.currentTime)+'</button>'+this.bookmarks.map(x=>`<button type="button" class="menu-row" data-seek="${x}">${formatTime(x)}</button>`).join('');
        if(p==='information'){const session=active.get(v),stats=(session?.player||this.adapter?.getPlayer?.())?.getStats?.()||{};html=`<p class="menu-note">DRM: ${escapeHtml(session?.drmSystem||'Not started')}<br>Video: ${v.videoWidth} × ${v.videoHeight}<br>Buffer: ${Math.max(0,(v.buffered.length?v.buffered.end(v.buffered.length-1):0)-v.currentTime).toFixed(1)} s<br>Dropped frames: ${Number(stats.droppedFrames)||0}<br>Support ID: ${escapeHtml(session?.operation?.attemptId||'—')}</p>`;}
        if(p==='shortcuts')html='<p class="menu-note">K / Space — Play / pause<br>J / L — Back / forward 10 seconds<br>← / → — Seek 5 seconds<br>M — Mute · C — Captions<br>F — Fullscreen · T — Theater<br>Shift+N / Shift+P — Next / previous<br>0–9 — Seek by percentage<br>&lt; / &gt; — Playback speed<br>Escape — Close menu</p>';
        body.innerHTML=html;if(p==='transcript')this.renderTranscript('');if(focusedChoice!==undefined)Array.from(body.querySelectorAll('[data-choice]')).find(button=>button.dataset.choice===focusedChoice&&button.dataset.field===focusedField)?.focus({preventScroll:true});
      }
      renderTranscript(query){const node=this.settings.querySelector('.transcript-results');if(node)node.innerHTML=this.transcript.filter(c=>c.text.toLowerCase().includes(query.toLowerCase())).slice(0,200).map(c=>`<button type="button" class="menu-row" data-seek="${c.start}"><span>${escapeHtml(c.text)}</span><span class="menu-value">${formatTime(c.start)}</span></button>`).join('');}
      async uiAction(target){
        if(target.dataset.index!==undefined){this.closeSettings(false);return this.playIndex(Number(target.dataset.index));}
        if(target.dataset.seek!==undefined){this.seekTo(Number(target.dataset.seek));return;}
        if(target.dataset.menu){this.menuPage=target.dataset.menu;this.renderMenu();return;}
        if(target.dataset.choice!==undefined){const value=target.dataset.choice;switch(target.dataset.field){case 'quality':await this.controlApi.selectQuality(this.video,value);break;case 'audio':await this.controlApi.selectAudioTrack(this.video,value);this.preferences.audio=this.controlApi.getTracks(this.video).audioTracks.find(t=>t.id===value)?.language;this.savePreferences();break;case 'captions':if(value==='off')await this.controlApi.hideSubtitles(this.video);else await this.controlApi.selectSubtitleTrack(this.video,value);this.preferences.captions=value==='off'?'off':this.controlApi.getTracks(this.video).subtitleTracks.find(t=>t.id===value)?.language;this.savePreferences();break;case 'speed':this.video.playbackRate=Number(value);break;case 'sleep':global.clearTimeout(this.sleepTimer);this.sleepAtEnd=value==='end';this.sleepDeadline=Number(value)>0?Date.now()+Number(value)*60000:null;if(this.sleepDeadline)this.sleepTimer=global.setTimeout(()=>{this.video.pause();this.cancelNext();this.sleepDeadline=null;this.announce('Sleep timer paused playback');},Number(value)*60000);break;}this.renderMenu();this.refreshUniversalUi();return;}
        switch(target.dataset.action){case 'close-about':this.protectionInfo.hidden=true;this.stage.focus();break;case 'context-info':this.protectionInfo.hidden=true;this.settings.hidden=false;this.gear.setAttribute('aria-expanded','true');this.menuPage='information';this.renderMenu();this.showUi();break;case 'previous':return this.previous();case 'next':this.cancelNext();return this.next();case 'cancel-next':this.cancelNext();break;case 'back':this.seekBy(-10);break;case 'forward':this.seekBy(10);break;case 'live':this.seekTo(this.seekEnd);break;case 'theater':this.stage.classList.toggle('theater');break;case 'close-menu':this.closeSettings(true);break;case 'menu-back':this.menuPage=this.menuPage==='style'?'captions':'main';this.renderMenu();break;case 'shuffle':this.queue.setShuffle(!this.queue.shuffle);this.renderQueue();break;case 'repeat':this.queue.repeat=({off:'all',all:'one',one:'off'})[this.queue.repeat];this.renderQueue();this.announce('Repeat '+this.queue.repeat);break;case 'cc':{const t=this.controlApi.getTracks(this.video).subtitleTracks;if(t.some(x=>x.active))this.controlApi.hideSubtitles(this.video);else if(t.length)this.controlApi.selectSubtitleTrack(this.video,t[0].id);this.refreshUniversalUi();break;}case 'bookmark':if(!this.bookmarks.includes(Math.floor(this.video.currentTime)))this.bookmarks.push(Math.floor(this.video.currentTime));this.bookmarks=this.bookmarks.slice(-100);this.renderMenu();break;case 'ab':if(this.loopB!=null){this.loopA=null;this.loopB=null;}else if(this.loopA==null)this.loopA=this.video.currentTime;else if(this.video.currentTime>this.loopA+1)this.loopB=this.video.currentTime;else this.announce('Seek past A before setting B');this.renderMenu();break;case 'stop':return this.stop();}
      }

      disconnectedCallback() {
        this.playGeneration=(this.playGeneration||0)+1;this.saveResume(true);this.uiAbort?.abort(); this.cancelNext();
        for(const timer of [this.hideUiTimer,this.noticeTimer,this.sleepTimer,this.videoClickTimer])global.clearTimeout(timer);
        global.document?.removeEventListener?.("pointerdown", this.closeProtectionInfo);
        if (this.video && !this.adapter) void api.stop(this.video, "disconnected");
      }

      showProtectionInfo(event) {
        const desktopPointer = global.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches
          ?? Number(global.navigator?.maxTouchPoints || 0) === 0;
        if (!desktopPointer) return;
        event.preventDefault();
        const rect = this.stage.getBoundingClientRect();
        this.closeSettings(false);this.protectionInfo.querySelector('.about-content').innerHTML=this.aboutHtml();
        this.protectionInfo.hidden = false;
        const left = Math.max(8, Math.min(event.clientX - rect.left, rect.width - this.protectionInfo.offsetWidth - 8));
        const top = Math.max(8, Math.min(event.clientY - rect.top, rect.height - this.protectionInfo.offsetHeight - 8));
        this.protectionInfo.style.left = `${left}px`;
        this.protectionInfo.style.top = `${top}px`;
        this.protectionInfo.querySelector('a')?.focus();
      }

      updateMediaUi() {
        const playing = !this.video.paused && !this.video.ended;
        this.stage.classList.toggle("playing", playing);
        this.toggle.textContent = playing ? "❚❚" : "▶";
        this.toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
        this.mute.textContent = this.video.muted || this.video.volume === 0 ? "🔇" : "🔊";
        this.volume.value = String(this.video.volume);
        this.current.textContent = formatTime(this.video.currentTime);
        this.total.textContent = formatTime(this.video.duration);
        this.refreshUniversalUi?.();
        if(this.queue)return;
        this.timeline.value = Number.isFinite(this.video.duration) && this.video.duration > 0
          ? String(Math.round((this.video.currentTime / this.video.duration) * 1000)) : "0";
      }

      populateSettings(tracks) {
        const selectedQuality = this.quality.value || "auto";
        this.quality.innerHTML = '<option value="auto">Auto</option>' + (tracks.qualityOptions || [])
          .map((item) => `<option value="${escapeHtml(item.height)}">${escapeHtml(item.height)}p${item.height >= 2160 ? " · 4K" : ""}</option>`).join("");
        this.quality.value = tracks.qualityMode || selectedQuality;
        this.audio.innerHTML = (tracks.audioTracks || []).map((item) => {
          const channels = item.channelsCount ? ` · ${item.channelsCount === 2 ? "Stereo" : `${item.channelsCount} ch`}` : "";
          return `<option value="${escapeHtml(item.id)}"${item.active ? " selected" : ""}>${escapeHtml(item.label || item.language || "Audio")}${escapeHtml(channels)}</option>`;
        }).join("") || '<option value="">Default</option>';
        this.subtitles.innerHTML = '<option value="off">Off</option>' + (tracks.subtitleTracks || [])
          .map((item) => `<option value="${escapeHtml(item.id)}"${item.active ? " selected" : ""}>${escapeHtml(item.label || item.language || "Subtitles")}</option>`).join("");
      }

      async togglePlayback() {
        if(this.adapter){if(!this.video.currentSrc && !this.video.src)return this.play();if(this.video.paused)return this.video.play();this.video.pause();return;}
        if (!active.get(this.video)) return this.play();
        if (this.video.paused) return this.video.play();
        this.video.pause();
      }

      async toggleFullscreen() {
        try {
          if (this.video.webkitDisplayingFullscreen && typeof this.video.webkitExitFullscreen === "function") {
            this.video.webkitExitFullscreen();
            return;
          }
          if (global.document?.fullscreenElement && typeof global.document.exitFullscreen === "function") {
            await global.document.exitFullscreen();
            return;
          }
          if (isAppleMobileBrowser() && typeof this.video.webkitEnterFullscreen === "function") {
            this.video.webkitEnterFullscreen();
            return;
          }
          if (typeof this.stage.requestFullscreen === "function") {
            await this.stage.requestFullscreen();
            return;
          }
          if (typeof this.video.webkitEnterFullscreen === "function") {
            this.video.webkitEnterFullscreen();
            return;
          }
          throw new Error("Fullscreen is unavailable in this browser.");
        } catch (error) {
          this.status.textContent = error?.message || "Fullscreen is unavailable in this browser.";
        }
      }

      async play() {
        if(this.adapter){await this.adapter.play();this.refreshUniversalUi();return;}
        this.cancelNext();
        const generation = this.playGeneration = (this.playGeneration || 0) + 1;
        this.saveResume(true);
        const contentId=this.getAttribute('content-id'),resumeKey=this.resumeStorageKey(),startPosition=this.readResume();
        this.loadedContentId=null;
        try {
          this.spinner.hidden = false; this.status.textContent = "Preparing protected playback…";
          const result = await api.start({
            video: this.video,
            contentId,
            contentType: this.getAttribute("content-type") || "vod",
            drmSystem: this.getAttribute("drm-system") || "auto",
            sessionEndpoint: this.getAttribute("session-endpoint") || "/api/drmx/playback-session",
            logEndpoint: this.getAttribute("log-endpoint") || null,
            adTagUrl: this.getAttribute("ad-tag-url") || null,
            adContainer: this.shadowRoot.querySelector(".ad"),
            startPosition,
          });
          if(generation !== this.playGeneration)return;
          this.loadedContentId=contentId;
          this.loadedResumeKey=resumeKey;this.resumeWrittenAt=0;
          this.applyBranding(result.playerBranding);
          this.spinner.hidden = true;
          this.status.textContent = result.requiresUserPlay ? "Protected media is ready. Press Play."
            : `Playing with ${result.drmSystem}${result.playbackPath ? ` · ${result.playbackPath}` : ""}.`;
          this.populateSettings(result);
          if(this.preferences.audio)try{this.controlApi.selectAudioLanguage(this.video,this.preferences.audio);}catch{}
          if(this.preferences.captions && this.preferences.captions!=="off")try{this.controlApi.selectSubtitleLanguage(this.video,this.preferences.captions);}catch{}
          this.refreshUniversalUi();this.showUi();
        } catch (error) {
          if(generation !== this.playGeneration)return;
          this.spinner.hidden = true;
          this.status.textContent = error?.name === "AbortError" ? "Playback canceled. Press Play to try again." : error?.message || "Playback failed.";
        }
      }

      async stop() {
        this.saveResume(true);this.loadedContentId=null;
        if(this.adapter){this.cancelNext();await this.adapter.stop();this.closeSettings(false);return;}
        this.playGeneration = (this.playGeneration || 0) + 1; this.cancelNext();
        await api.stop(this.video); this.closeSettings(false);
        this.status.textContent = "Stopped; playback session released."; this.updateMediaUi();
      }

      closeSettings(restoreFocus = false) {
        this.settings.hidden = true;
        this.gear?.setAttribute?.("aria-expanded", "false");
        if (restoreFocus) this.gear?.focus?.();
        this.showUi();
      }

      handleKey(event) {
        if(event.key==='Escape'){this.protectionInfo.hidden=true;this.closeSettings(true);return;}
        if (/^(SELECT|INPUT|TEXTAREA)$/.test(event.target?.tagName || '')) return;
        const k=event.key.toLowerCase();
        if(k===' ' && event.target?.tagName==='BUTTON')return;
        if(event.shiftKey&&k==='n'){event.preventDefault();void this.next();return;}
        if(event.shiftKey&&k==='p'){event.preventDefault();void this.previous();return;}
        if(k===' '||k==='k'){event.preventDefault();void this.togglePlayback();}
        else if(k==='m')this.video.muted=!this.video.muted;
        else if(k==='f')void this.toggleFullscreen();
        else if(k==='t')this.stage.classList.toggle('theater');
        else if(k==='c')this.shadowRoot.querySelector('.cc').click();
        else if(['j','l','arrowleft','arrowright'].includes(k)){event.preventDefault();this.seekBy(({j:-10,l:10,arrowleft:-5,arrowright:5})[k]);}
        else if(/^[0-9]$/.test(k))this.seekTo(this.seekStart+Number(k)/10*(this.seekEnd-this.seekStart));
        else if(k==='>'||k==='<')this.video.playbackRate=Math.max(.25,Math.min(2,this.video.playbackRate+(k==='>'?.25:-.25)));
        this.showUi();
      }
    }
    global.customElements.define("drmx-universal-player", DrmXUniversalPlayerElement);
  }

  global.addEventListener?.("pagehide", () => {
    for (const video of [...liveVideos]) void stop(video, "pagehide");
  });
})(window);
