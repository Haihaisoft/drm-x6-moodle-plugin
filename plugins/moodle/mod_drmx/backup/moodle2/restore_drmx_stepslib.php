<?php
defined('MOODLE_INTERNAL') || die();
class restore_drmx_activity_structure_step extends restore_activity_structure_step {
    protected function define_structure() { return $this->prepare_activity_structure([new restore_path_element('drmx', '/activity/drmx')]); }
    protected function process_drmx($data) {
        global $DB;
        $data = (object) $data; $data->course = $this->get_courseid();
        $data->timecreated = $this->apply_date_offset($data->timecreated); $data->timemodified = time();
        // Restoring a course must not silently publish its old protected media mapping.
        $data->contentid = '';
        $newid = $DB->insert_record('drmx', $data); $this->apply_activity_instance($newid);
    }
    protected function after_execute() { $this->add_related_files('mod_drmx', 'intro', null); }
}
