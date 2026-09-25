# DRM-X 6.0 Moodle integration

Activity 1.3.0-preview.6; optional filter 1.3.0-preview.2;
Universal Player 1.2.0-preview.13.

1. Install the activity ZIP in Site administration → Plugins → Install plugins
   (mod/drmx). Complete the Moodle database upgrade.
2. Open the DRM-X activity settings. Enter Site ID, Site Key, Access Key and
   default policy. Host-managed deployments can use forced_plugin_settings.
3. Enable course editing and add DRM-X Protected Video. Enter the exact published
   Content ID, VOD/Live type and policy. Set native Moodle availability and completion.
4. Save and display. Test with an enrolled learner and a denied account.

You do not need custom entitlement code for standard Moodle access. Every session
checks login, enrollment, mod/drmx:view, activity visibility and the saved Content ID.
Guests, suspended users and unavailable activities are denied. Completion tracks
activity viewed, not proof that the whole video was watched.

## Optional filter

Install filter_drmx after the activity and enable it in Manage filters. Embed an
existing activity with {drmx activityid="123"}, using the course-module ID from
its URL, not the internal video record ID. Legacy contentid markup works only
when it resolves to one matching activity in the current course.

## Upgrade and restore

Back up Moodle. Replace the activity with preview.6, keep the optional filter at
preview.2, complete Site administration → Notifications and purge all caches.
The activity bundles its player runtime; remove older manually pasted player
scripts from the page. Do not disable Moodle RequireJS.

Normal upgrades retain mappings. Restoring a course backup clears Content ID;
an administrator must confirm and re-enter the destination mapping. Course backups
must not contain server credentials.

Requests must be JSON under 16 KiB. Returned sessions must match the activity's
Content ID. Keep the supplied endpoint and player. Use HTTPS and test enrollment,
suspension, hidden activities, date/group restrictions, content substitution,
backup restoration, real playback and Stop on your supported devices.

[Moodle setup and field map](https://docs.drm-x.com/en/integrations/moodle-activity)
