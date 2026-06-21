<?php
/**
 * Lists all available rasterization manifests.
 *
 * Responds with a JSON array of { name, path, levels, totalTiles }.
 * Used by debug-tiles.html to populate the manifest selector.
 */

header('Content-Type: application/json');

$baseDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'rasterizationData';
$manifests = [];

if (is_dir($baseDir)) {
    foreach (scandir($baseDir) as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $svgDir = $baseDir . DIRECTORY_SEPARATOR . $entry;
        if (!is_dir($svgDir)) continue;
        $manifestPath = $svgDir . DIRECTORY_SEPARATOR . 'manifest.json';
        if (!file_exists($manifestPath)) continue;

        $json = @json_decode(file_get_contents($manifestPath), true);
        if (!$json) continue;

        $manifests[] = [
            'name'       => $json['svgName'] ?? $entry,
            'path'       => '../rasterizationData/' . $entry . '/manifest.json',
            'levels'     => $json['numLevels'] ?? 0,
            'totalTiles' => $json['totalTiles'] ?? 0,
        ];
    }
}

// Sort by name
usort($manifests, fn($a, $b) => strcmp($a['name'], $b['name']));

echo json_encode($manifests, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);