<?php
defined('MOODLE_INTERNAL') || die();
require_once($CFG->dirroot . '/mod/drmx/backup/moodle2/backup_drmx_stepslib.php');
class backup_drmx_activity_task extends backup_activity_task {
    protected function define_my_settings() {}
    protected function define_my_steps() { $this->add_step(new backup_drmx_activity_structure_step('drmx_structure', 'drmx.xml')); }
    public static function encode_content_links($content) { return $content; }
}
