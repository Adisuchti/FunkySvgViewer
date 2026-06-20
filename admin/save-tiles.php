<?php
/**
 * Receives tile PNG blobs from the client-side pre-renderer
 * and saves them to rasterizationData/<svgName>/tiles/
 *
 * POST parameters:
 *   svgName  — e.g. "Altis_Map"
 *   level    — pyramid level
 *   col      — tile column
 *   row      — tile row
 *   tile     — PNG blob (file upload)
 *
 * Also writes manifest.json when ?manifest=1 with JSON body.
 */

header('Content-Type: application/json');

$outDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'rasterizationData';

// ── Handle manifest write ──────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_GET['manifest'])) {
    $json = file_get_contents('php://input');
    $data = json_decode($json, true);
    if (!$data || empty($data['svgName'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid manifest data']);
        exit;
    }
    $svgName = $data['svgName'];
    $svgDir  = $outDir . DIRECTORY_SEPARATOR . $svgName;
    @mkdir($svgDir, 0777, true);
    file_put_contents($svgDir . DIRECTORY_SEPARATOR . 'manifest.json', json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    echo json_encode(['ok' => true]);
    exit;
}

// ── Handle single tile upload ──────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['svgName'])) {
    $svgName = trim($_POST['svgName']);
    $level   = intval($_POST['level']);
    $col     = intval($_POST['col']);
    $row     = intval($_POST['row']);

    if ($svgName === '' || !isset($_FILES['tile'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing parameters']);
        exit;
    }

    $tilesDir = $outDir . DIRECTORY_SEPARATOR . $svgName . DIRECTORY_SEPARATOR . 'tiles';
    @mkdir($tilesDir, 0777, true);

    $filename = sprintf('L%d-R%d-C%d.png', $level, $row, $col);
    $dest = $tilesDir . DIRECTORY_SEPARATOR . $filename;

    if (move_uploaded_file($_FILES['tile']['tmp_name'], $dest)) {
        echo json_encode(['ok' => true, 'file' => $filename]);
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to write file']);
    }
    exit;
}

// ── List existing tiles for an SVG ─────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['svg'])) {
    $svgName = trim($_GET['svg']);
    $tilesDir = $outDir . DIRECTORY_SEPARATOR . $svgName . DIRECTORY_SEPARATOR . 'tiles';
    $manifestFile = $outDir . DIRECTORY_SEPARATOR . $svgName . DIRECTORY_SEPARATOR . 'manifest.json';

    $tiles = [];
    if (is_dir($tilesDir)) {
        foreach (scandir($tilesDir) as $f) {
            if (preg_match('/^L\d+-R\d+-C\d+\.png$/', $f)) {
                $tiles[] = $f;
            }
        }
    }

    echo json_encode([
        'svgName'      => $svgName,
        'tileCount'    => count($tiles),
        'manifestExists' => file_exists($manifestFile),
    ]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action']);