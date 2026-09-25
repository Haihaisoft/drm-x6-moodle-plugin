<?php
defined('MOODLE_INTERNAL') || die();
function drmx_activity_context(int $cmid): array {
    global $DB;
    $cm = get_coursemodule_from_id('drmx', $cmid, 0, false, MUST_EXIST);
    $course = $DB->get_record('course', ['id' => $cm->course], '*', MUST_EXIST);
    require_login($course, true, $cm);
    if (isguestuser()) { throw new required_capability_exception(context_module::instance($cmid), 'mod/drmx:view', 'nopermissions', ''); }
    $context = context_module::instance($cmid); require_capability('mod/drmx:view', $context);
    if (!get_fast_modinfo($course)->get_cm($cmid)->uservisible) { throw new moodle_exception('activityiscurrentlyhidden'); }
    $activity = $DB->get_record('drmx', ['id' => $cm->instance, 'course' => $course->id], '*', MUST_EXIST);
    return [$activity, $course, $cm, $context];
}
function drmx_player_markup($activity, $cm): string {
    global $PAGE;
    // Moodle uses RequireJS. The packaged Shaka browser export scopes its UMD
    // detection without removing or replacing Moodle's global AMD loader.
    // Moodle deduplicates these ordered includes for multiple filtered embeds.
    $PAGE->requires->js('/mod/drmx/vendor/shaka-player-5.2.4-drmx.2-browser.js');
    $PAGE->requires->js('/mod/drmx/vendor/drmx-universal-player-1.2.0-preview.13.js');
    $endpoint = new moodle_url('/mod/drmx/session.php', ['cmid' => $cm->id, 'sesskey' => sesskey()]);
    return html_writer::tag('drmx-universal-player', '', ['content-id' => $activity->contentid,
        'content-type' => $activity->contenttype, 'session-endpoint' => $endpoint->out(false)]);
}
function drmx_activity_payload($activity, array $input, string $subject, string $defaultpolicy): array {
    $drm = $input['drmSystem'] ?? '';
    if (trim($activity->contentid) === '' || ($input['contentId'] ?? '') !== $activity->contentid || ($input['contentType'] ?? 'vod') !== $activity->contenttype ||
        !in_array($drm, ['widevine', 'playready', 'fairplay', 'wiseplay'], true)) {
        throw new invalid_parameter_exception('The playback request must match the authorized activity.');
    }
    $policy = $activity->policy ?: $defaultpolicy;
    if (!in_array($policy, ['', 'single-software', 'single-hdcp', 'single-hardware', 'multi-tier-standard'], true)) {
        throw new invalid_parameter_exception('Invalid DRM-X policy.');
    }
    $caps = is_array($input['platformCapabilities'] ?? null) ? $input['platformCapabilities'] : [];
    $height = is_numeric($caps['maximumHeight'] ?? null) ? (int) $caps['maximumHeight'] : 1080;
    $payload = ['contentId' => $activity->contentid, 'contentType' => $activity->contenttype, 'drmSystem' => $drm,
        'subject' => $subject, 'playbackMode' => 'streaming', 'useEnvironmentDefaults' => true, 'applicationId' => 'moodle-drmx',
        'platformCapabilities' => ['clientPlatform' => 'web', 'drmSystems' => [$drm], 'manifestTypes' => [$drm === 'fairplay' ? 'hls' : 'dash'],
            'maximumHeight' => min(4320, max(144, $height)), 'persistentState' => false, 'sdkVersion' => '1.2.0-preview.13']];
    if ($policy !== '') { $payload['licensePolicyTemplate'] = $policy; }
    return $payload;
}
