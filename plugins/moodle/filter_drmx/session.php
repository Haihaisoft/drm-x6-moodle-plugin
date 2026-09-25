<?php
// Compatibility URL: requests must now identify a trusted DRM-X activity.
if (!isset($_GET['cmid'])) {
    header('Content-Type: application/json'); header('Cache-Control: no-store'); http_response_code(403);
    echo json_encode(['contractVersion' => 1, 'status' => 403, 'code' => 'activity_mapping_required',
        'title' => 'Create a DRM-X activity and refresh the embedded player.', 'retryable' => false]); exit;
}
require(__DIR__ . '/../../mod/drmx/session.php');
