# DRM-X 6.0 — Moodle

[English](README.md) | [简体中文](README.zh-Hans.md) | [Español](README.es.md)

Developer source, integration examples and setup guidance for protected video with **Moodle**. DRM-X 6.0 provides Multi-DRM playback while your application keeps its existing users, content catalog and access rules.

[DRM-X 6.0 website](https://multi-drm.drm-x.com/) · [Step-by-step documentation](https://docs.drm-x.com/integrations/moodle-activity) · [All integrations](https://docs.drm-x.com/integrations/source-downloads) · [Live examples](https://developer.drm-x.com/)

## Start here

Release **20260925.7**, public preview. Requirements: **Moodle; server requirements in the guide**. Component licenses and third-party notices remain in their source folders.

- Start with [`plugins/moodle/mod_drmx/README.md`](plugins/moodle/mod_drmx/README.md).
- Files and extension points to configure: **`Site administration → Plugins; DRM-X activity → Content ID`**.
- [Download the tested platform package](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-20260925.7-source.zip) or clone this repository. Preserve the folder layout so local SDK dependencies resolve correctly.

1. Install the [DRM-X activity ZIP](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-activity-1.3.0-preview.6-3ed2cfca2d77.zip) through Moodle's plugin installer. The [filter ZIP](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-filter-1.3.0-preview.2-062604820a5a.zip) is optional and is not a replacement for the activity.
2. Configure server credentials in **Site administration → Plugins**.
3. Add a DRM-X activity to the course and enter its published **Content ID**. Keep Moodle enrollment, roles and availability restrictions.
4. Test allowed and denied learners. Viewing an activity does not prove that the entire video was watched. Restoring an activity clears its Content ID; check and map it again.

Source folders: `plugins/moodle/mod_drmx` and `plugins/moodle/filter_drmx`. Use the installer links for normal installation, not GitHub's automatic repository ZIP.

## How integration works

1. Encrypt and publish a video, then copy its **Content ID**. With configured 1aicloud/S3 publishing, DRM-X records the media URLs. If you upload protected files to your own server, register their DASH/HLS media URLs in DRM-X first.
2. Configure **Site ID**, **Site Key** and **Access Key** on the server, following the platform guide. Never put these credentials in client-side code or Git.
3. Use your existing login and check the current user's purchase, membership or enrollment. Map your own video/lesson ID to the authorized DRM-X Content ID.
4. The backend requests playback and the player receives the registered manifest and **DRM License Token**. Normal streaming integration supplies Content ID; it does not require customers to enter the manifest URL in their website code.

## Before production

Remove local demo identities, use HTTPS, and test signed-out, unauthorized, revoked and allowed access with your target browsers and devices. Deny access when authorization cannot be established. An already issued DRM license follows its own policy lifetime. Keep server credentials out of logs, issues and screenshots.

The source, SDK packages and examples are supplied for developers; runtime dependencies may require installation from their normal package registries. These previews do not claim certification for every browser, device, LMS or hosted platform. Follow the linked guide for platform-specific prerequisites and limitations.

## License and help

See [LICENSE](LICENSE) and the licenses/notices inside SDK, plugin and vendor folders. A source license does not include a DRM-X service subscription or third-party LMS licenses. Use the [documentation](https://docs.drm-x.com/integrations/moodle-activity) for integration help and the [DRM-X 6.0 website](https://multi-drm.drm-x.com/) to explore the service. Report reproducible code issues without credentials or customer data.
