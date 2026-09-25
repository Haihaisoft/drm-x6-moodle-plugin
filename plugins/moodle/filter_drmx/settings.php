<?php
defined('MOODLE_INTERNAL') || die();
if ($ADMIN->fulltree) {
    $settings->add(new admin_setting_heading('filter_drmx/activitysettings', 'DRM-X protected video',
        'Install the DRM-X activity module and configure Site ID, Site Key, Access Key and policy under Plugins → Activity modules → DRM-X protected video. Existing filter credentials are not used by the activity module.'));
}
