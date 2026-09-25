<?php
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');
require_once($CFG->libdir . '/completionlib.php');
$id = required_param('id', PARAM_INT);
[$activity, $course, $cm, $context] = drmx_activity_context($id);
$PAGE->set_url('/mod/drmx/view.php', ['id' => $id]); $PAGE->set_context($context);
$PAGE->set_title(format_string($activity->name)); $PAGE->set_heading(format_string($course->fullname));
$PAGE->set_cacheable(false);
$player = drmx_player_markup($activity, $cm);
$completion = new completion_info($course); $completion->set_module_viewed($cm);
echo $OUTPUT->header(); echo $OUTPUT->heading(format_string($activity->name));
echo format_module_intro('drmx', $activity, $cm->id); echo $player; echo $OUTPUT->footer();
