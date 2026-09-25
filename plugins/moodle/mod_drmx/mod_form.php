<?php
defined('MOODLE_INTERNAL') || die();
require_once($CFG->dirroot . '/course/moodleform_mod.php');
class mod_drmx_mod_form extends moodleform_mod {
    public function definition() {
        $mform = $this->_form;
        $mform->addElement('header', 'general', get_string('general', 'form'));
        $mform->addElement('text', 'name', get_string('name'), ['size' => 60]);
        $mform->setType('name', PARAM_TEXT); $mform->addRule('name', null, 'required');
        $this->standard_intro_elements();
        $mform->addElement('header', 'drmxvideo', get_string('videosettings', 'drmx'));
        $mform->addElement('static', 'mappinghelp', '', get_string('mappinghelp', 'drmx'));
        $mform->addElement('text', 'contentid', 'Content ID', ['size' => 60, 'maxlength' => 200, 'placeholder' => get_string('contentid_placeholder', 'drmx')]);
        $mform->setType('contentid', PARAM_TEXT); $mform->addRule('contentid', null, 'required');
        $mform->addHelpButton('contentid', 'contentid', 'drmx');
        $mform->addElement('select', 'contenttype', get_string('contenttype', 'drmx'), ['vod' => 'VOD', 'live' => get_string('live', 'drmx')]);
        $mform->addHelpButton('contenttype', 'contenttype', 'drmx');
        $mform->addElement('select', 'policy', get_string('policy', 'drmx'), drmx_policy_choices());
        $mform->addHelpButton('policy', 'policy', 'drmx');
        $this->standard_coursemodule_elements(); $this->add_action_buttons();
    }
    public function validation($data, $files) {
        $errors = parent::validation($data, $files);
        if (trim($data['contentid'] ?? '') === '' || strlen($data['contentid'] ?? '') > 200) { $errors['contentid'] = get_string('invalidcontent', 'drmx'); }
        if (!in_array($data['contenttype'] ?? '', ['vod', 'live'], true)) { $errors['contenttype'] = get_string('invalidtype', 'drmx'); }
        if (!array_key_exists($data['policy'] ?? '', drmx_policy_choices())) { $errors['policy'] = get_string('invalidpolicy', 'drmx'); }
        return $errors;
    }
}
function drmx_policy_choices(): array {
    return ['' => get_string('defaultpolicy', 'drmx'), 'single-software' => get_string('policy_standard', 'drmx'),
        'single-hdcp' => get_string('policy_hdcp', 'drmx'), 'single-hardware' => get_string('policy_hardware', 'drmx'), 'multi-tier-standard' => get_string('policy_quality', 'drmx')];
}
