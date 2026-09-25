<?php
defined('MOODLE_INTERNAL') || die();
if ($ADMIN->fulltree) {
    $settings->add(new admin_setting_heading('mod_drmx/help', 'DRM-X 6.0', '<a href="https://docs.drm-x.com/integrations/moodle-activity">DRM-X setup guide</a> · <a href="https://multi-drm.drm-x.com/solutions/education">DRM-X for education</a>'));
    $settings->add(new admin_setting_configtext('mod_drmx/siteid', 'Site ID', '', '', PARAM_TEXT));
    $settings->add(new admin_setting_configtext('mod_drmx/sitekey', 'Site Key', '', '', PARAM_TEXT));
    $settings->add(new admin_setting_configpasswordunmask('mod_drmx/accesskey', 'Access Key', get_string('secret_help', 'drmx'), ''));
    $settings->add(new admin_setting_configselect('mod_drmx/policy', get_string('policy', 'drmx'), get_string('policy_help', 'drmx'), '',
        ['' => get_string('defaultpolicy', 'drmx'), 'single-software' => get_string('policy_standard', 'drmx'), 'single-hdcp' => get_string('policy_hdcp', 'drmx'), 'single-hardware' => get_string('policy_hardware', 'drmx'), 'multi-tier-standard' => get_string('policy_quality', 'drmx')]));
}
