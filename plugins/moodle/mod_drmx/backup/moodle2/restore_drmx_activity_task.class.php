<?php
defined('MOODLE_INTERNAL') || die();
require_once($CFG->dirroot . '/mod/drmx/backup/moodle2/restore_drmx_stepslib.php');
class restore_drmx_activity_task extends restore_activity_task {
    protected function define_my_settings() {}
    protected function define_my_steps() { $this->add_step(new restore_drmx_activity_structure_step('drmx_structure', 'drmx.xml')); }
    public static function define_decode_contents() { return [new restore_decode_content('drmx', ['intro'], 'drmx')]; }
    public static function define_decode_rules() { return []; }
    public static function define_restore_log_rules() { return []; }
}
