<?php
/**
 * Polling endpoint: reads the Node.js pre-render progress file
 * and returns JSON with current status.
 *
 * Called by pre-render.php via AJAX.
 *
 * Query params:
 *   svg  — SVG name (without extension)
 *
 * Returns JSON:
 *   { pct: number, log: string, done: boolean, manifestUrl?: string }
 */

header('Content-Type: application/json');

$svgName = $_GET['svg'] ?? '';
if (!$svgName || !preg_match('/^[a-zA-Z0-9_.-]+$/', $svgName)) {
    echo json_encode(['error' => 'Invalid SVG name']);
    exit;
}

$baseDir  = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'rasterizationData';
$svgDir   = $baseDir . DIRECTORY_SEPARATOR . $svgName;
$progressFile = $svgDir . DIRECTORY_SEPARATOR . 'progress.txt';
$manifestFile = $svgDir . DIRECTORY_SEPARATOR . 'manifest.json';

// ── Check if done ──────────────────────────────────────────────────
// The Node.js script writes progress.txt first, then manifest.json last.
// If manifest.json exists, the process is complete.
$done = file_exists($manifestFile);

// ── Read log ───────────────────────────────────────────────────────
$log = '';
if (file_exists($progressFile)) {
    $log = file_get_contents($progressFile);
    if ($log === false) $log = '';
}

// ── Compute percentage ──────────────────────────────────────────────
$pct = 0;
if ($done) {
    $pct = 100;
} elseif ($log) {
    // Parse Node.js output like: "  [42%] 123/341 tiles"
    if (preg_match('/\[(\d+)%\]/', $log, $m)) {
        $pct = (int)$m[1];
    }
}

// ── Result ──────────────────────────────────────────────────────────
$result = [
    'pct'  => $pct,
    'log'  => $log,
    'done' => $done,
];

if ($done) {
    $result['manifestUrl'] = 'rasterizationData/' . rawurlencode($svgName) . '/manifest.json';
}

echo json_encode($result);