<?php
defined('MOODLE_INTERNAL') || die();
class backup_drmx_activity_structure_step extends backup_activity_structure_step {
    protected function define_structure() {
        $activity = new backup_nested_element('drmx', ['id'], ['name', 'intro', 'introformat', 'contentid', 'contenttype', 'policy', 'timecreated', 'timemodified']);
        $activity->set_source_table('drmx', ['id' => backup::VAR_ACTIVITYID]);
        $activity->annotate_files('mod_drmx', 'intro', null);
        return $this->prepare_activity_structure($activity);
    }
}
