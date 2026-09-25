<?php
define('AJAX_SCRIPT', true);
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/locallib.php');
header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
function drmx_fail(int $status, string $code): never {
    http_response_code($status);
    echo json_encode(['contractVersion' => 1, 'status' => $status, 'code' => $code, 'title' => 'Protected playback is unavailable for this request.', 'retryable' => false]); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { drmx_fail(405, 'method_not_allowed'); }
try {
    require_sesskey();
    [$activity, $course, $cm] = drmx_activity_context(required_param('cmid', PARAM_INT));
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') { drmx_fail(415, 'json_required'); }
    $raw = file_get_contents('php://input', false, null, 0, 16385);
    if (strlen($raw) > 16384) { drmx_fail(413, 'request_too_large'); }
    $input = json_decode($raw, true);
    if (!is_array($input)) { drmx_fail(400, 'playback_session_invalid'); }
    $config = get_config('mod_drmx');
    if (empty($config->siteid) || empty($config->sitekey) || empty($config->accesskey)) { drmx_fail(503, 'playback_configuration_missing'); }
    $subject = 'moodle:' . substr(hash('sha256', $CFG->wwwroot), 0, 24) . ':' . $USER->id;
    $payload = drmx_activity_payload($activity, $input, $subject, $config->policy ?? '');
} catch (Throwable $error) { drmx_fail(403, 'playback_not_authorized'); }
$curl = new curl();
$curl->setHeader(['Accept: application/json', 'Content-Type: application/json', 'X-DRMX-Client-Id: ' . $config->sitekey, 'X-DRMX-Client-Secret: ' . $config->accesskey]);
$body = $curl->post('https://api6.drm-x.com/api/v1/playback/environments/' . rawurlencode($config->siteid) . '/sessions', json_encode($payload),
    ['CURLOPT_TIMEOUT' => 12, 'CURLOPT_FOLLOWLOCATION' => false]);
$status = (int) ($curl->get_info()['http_code'] ?? 502); $decoded = is_string($body) ? json_decode($body, true) : null;
if ($status !== 200 || !is_array($decoded) || ($decoded['contractVersion'] ?? 0) !== 1 || ($decoded['contentId'] ?? '') !== $payload['contentId'] || strlen($body) > 262144) { drmx_fail($status === 429 ? 429 : 502, 'playback_session_unavailable'); }
echo json_encode($decoded);
