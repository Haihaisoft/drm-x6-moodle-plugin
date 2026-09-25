<?php
defined('MOODLE_INTERNAL') || die();
class filter_drmx extends moodle_text_filter {
    public function filter($text, array $options = []) {
        global $CFG, $COURSE, $DB;
        if (!is_string($text) || stripos($text, '{drmx') === false) { return $text; }
        if (!is_readable($CFG->dirroot . '/mod/drmx/locallib.php') || !isloggedin() || isguestuser()) { return $text; }
        require_once($CFG->dirroot . '/mod/drmx/locallib.php');
        return preg_replace_callback('/\{drmx\s+(?:activityid="([0-9]+)"|contentid="([A-Za-z0-9._:@\/-]{1,200})"(?:\s+contenttype="(vod|live)")?)\s*\}/i',
            static function ($match) use ($COURSE, $DB) {
                try {
                    if (!empty($match[1])) {
                        $cm = get_coursemodule_from_id('drmx', (int) $match[1], $COURSE->id, false, MUST_EXIST);
                        $record = $DB->get_record('drmx', ['id' => $cm->instance, 'course' => $COURSE->id], '*', MUST_EXIST);
                    } else {
                        $records = $DB->get_records('drmx', ['course' => $COURSE->id, 'contentid' => $match[2], 'contenttype' => strtolower($match[3] ?? 'vod')]);
                        if (count($records) !== 1) { return get_string('invalidcontent', 'drmx'); }
                        $record = reset($records); $cm = get_coursemodule_from_instance('drmx', $record->id, $COURSE->id, false, MUST_EXIST);
                    }
                    $info = get_fast_modinfo($COURSE)->get_cm($cm->id);
                    if (!$info->uservisible || !has_capability('mod/drmx:view', context_module::instance($cm->id))) { return ''; }
                    return drmx_player_markup($record, $cm);
                } catch (Throwable $error) { return ''; }
            }, $text);
    }
}
