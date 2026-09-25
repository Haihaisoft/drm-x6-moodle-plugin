<?php
defined('MOODLE_INTERNAL') || die();
function drmx_supports($feature) {
    return match ($feature) {
        FEATURE_MOD_INTRO, FEATURE_SHOW_DESCRIPTION, FEATURE_COMPLETION_TRACKS_VIEWS, FEATURE_BACKUP_MOODLE2 => true,
        FEATURE_MOD_PURPOSE => MOD_PURPOSE_CONTENT, default => null,
    };
}
function drmx_validate_activity($data): void {
    if (!is_string($data->contentid ?? null) || trim($data->contentid) === '' || strlen($data->contentid) > 200 ||
        !in_array($data->contenttype ?? '', ['vod', 'live'], true) ||
        !in_array($data->policy ?? '', ['', 'single-software', 'single-hdcp', 'single-hardware', 'multi-tier-standard'], true)) {
        throw new invalid_parameter_exception('Invalid DRM-X content mapping or policy.');
    }
}
function drmx_add_instance($data, $mform = null) {
    global $DB; drmx_validate_activity($data);
    $data->timecreated = time(); $data->timemodified = time(); return $DB->insert_record('drmx', $data);
}
function drmx_update_instance($data, $mform = null) {
    global $DB; drmx_validate_activity($data);
    $data->id = $data->instance; $data->timemodified = time(); return $DB->update_record('drmx', $data);
}
function drmx_delete_instance($id) {
    global $DB; $DB->delete_records('drmx', ['id' => $id]); return true;
}
function drmx_pluginfile($course, $cm, $context, $filearea, $args, $forcedownload, array $options = []) {
    if ($context->contextlevel !== CONTEXT_MODULE || $filearea !== 'intro') { return false; }
    require_once(__DIR__ . '/locallib.php');
    drmx_activity_context((int) $cm->id);
    $itemid = (int) array_shift($args); $filename = array_pop($args);
    $filepath = '/' . ($args ? implode('/', $args) . '/' : '');
    $file = get_file_storage()->get_file($context->id, 'mod_drmx', 'intro', $itemid, $filepath, $filename);
    if (!$file || $file->is_directory()) { return false; }
    send_stored_file($file, 0, 0, $forcedownload, $options);
}
