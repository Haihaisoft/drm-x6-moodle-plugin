<?php
require_once(__DIR__ . '/../../config.php');
$id = required_param('id', PARAM_INT);
$course = $DB->get_record('course', ['id' => $id], '*', MUST_EXIST); require_login($course);
redirect(new moodle_url('/course/view.php', ['id' => $id]));
