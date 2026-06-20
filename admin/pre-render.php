<?php
/**
 * PHP pre-render interface.
 *
 * Shows a form for configuring pyramid parameters, then rasterizes
 * tiles client-side using the browser's canvas.  After generation,
 * each tile PNG is uploaded to the server via save-tiles.php.
 *
 * Once tiles exist on the server, subsequent visitors load them
 * directly — no client-side rasterization needed.
 *
 * No Node.js required.
 */

$svgFile    = $_POST['svgFile']    ?? 'Altis_Map.svg';
$tileSize   = $_POST['tileSize']   ?? '256';
$numLevels  = ($_POST['numLevels']  ?? '') !== '' ? $_POST['numLevels']  : '5';
$lowestRes  = ($_POST['lowestRes']  ?? '') !== '' ? $_POST['lowestRes']  : '4096';
$highestRes = ($_POST['highestRes'] ?? '') !== '' ? $_POST['highestRes'] : '16384';
$svgName    = pathinfo($svgFile, PATHINFO_FILENAME);

// Check if server-side tiles already exist
$manifestPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'rasterizationData' . DIRECTORY_SEPARATOR . $svgName . DIRECTORY_SEPARATOR . 'manifest.json';
$serverReady = file_exists($manifestPath);
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>SVG Pan & Zoom — Pre-Render</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: monospace;
      background: #fff;
      color: #000;
      padding: 20px;
      min-height: 100vh;
    }
    h1 { font-size: 1.1rem; margin-bottom: 16px; }
    h2 { font-size: 0.9rem; margin: 16px 0 8px; }

    form {
      border: 2px solid #000;
      padding: 16px;
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 8px 12px;
      max-width: 650px;
      align-items: center;
    }
    form label { text-align: right; font-size: 0.8rem; }
    form input {
      padding: 4px 8px;
      border: 2px solid #000;
      background: #fff;
      color: #000;
      font-size: 0.8rem;
      font-family: monospace;
    }
    form button {
      grid-column: 2;
      padding: 6px 14px;
      border: 2px solid #000;
      background: #000;
      color: #fff;
      cursor: pointer;
      font-size: 0.85rem;
      font-family: monospace;
    }
    form button:hover { background: #fff; color: #000; }
    .hint { font-size: 0.7rem; color: #666; }

    #progress-section { display: none; margin-top: 20px; max-width: 650px; }
    #progress-bar-wrap {
      width: 100%; height: 10px; border: 2px solid #000;
      margin: 8px 0 12px;
    }
    #progress-bar-fill {
      height: 100%; width: 0%;
      background: #000;
      transition: width 0.2s;
    }
    #progress-pct { font-weight: bold; }
    #upload-status { margin-top: 4px; }

    #viewer-section { display: none; margin-top: 20px; }
    #viewer {
      width: 100%; height: 600px; border: 2px solid #000;
      background: #ccc;
    }
    .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
    .toolbar button {
      padding: 4px 10px;
      border: 2px solid #000;
      background: #000;
      color: #fff;
      cursor: pointer;
      font-size: 0.8rem;
      font-family: monospace;
    }
    .toolbar button:hover { background: #fff; color: #000; }
    .info { font-size: 0.8rem; margin-bottom: 12px; }
    .status-badge {
      display: inline-block; padding: 2px 8px; border: 2px solid #000;
      font-size: 0.75rem; font-weight: bold;
    }
    .status-ready { background: #000; color: #fff; }
    .status-missing { background: #fff; color: #000; }
  </style>
</head>
<body>

<h1>SVG Pan & Zoom — Pre-Render</h1>

<div class="info">
  <p>Client-side rasterization → saved to server → served as static PNGs for all future visitors.</p>
  <p>Status: 
    <span class="status-badge <?php echo $serverReady ? 'status-ready' : 'status-missing'; ?>">
      <?php echo $serverReady ? 'SERVER TILES READY' : 'NEEDS PRE-RENDER'; ?>
    </span>
  </p>
</div>

<form method="post" id="render-form">
  <label>SVG File</label>
  <input type="text" name="svgFile" value="<?php echo htmlspecialchars($svgFile); ?>" required />
  <label>Tile Size (px)</label>
  <input type="number" name="tileSize" value="<?php echo htmlspecialchars($tileSize); ?>" min="64" max="1024" />
  <label>Number of Levels</label>
  <div>
    <input type="number" name="numLevels" value="<?php echo htmlspecialchars($numLevels); ?>" min="1" max="12" style="width:100%" />
    <div class="hint">Leave empty for auto. Overrides highestRes.</div>
  </div>
  <label>Lowest Resolution (px)</label>
  <div>
    <input type="number" name="lowestRes" value="<?php echo htmlspecialchars($lowestRes); ?>" min="64" style="width:100%" />
    <div class="hint">Full-SVG pixel width at coarsest level.</div>
  </div>
  <label>Highest Resolution (px)</label>
  <div>
    <input type="number" name="highestRes" value="<?php echo htmlspecialchars($highestRes); ?>" min="256" style="width:100%" />
    <div class="hint">Full-SVG pixel width at finest level. Ignored if numLevels set.</div>
  </div>
  <button type="submit">Pre-Render & Upload to Server</button>
</form>

<div id="progress-section">
  <h2 id="progress-heading">Rasterizing tiles…</h2>
  <div id="progress-bar-wrap"><div id="progress-bar-fill"></div></div>
  <span id="progress-pct">0%</span>
  <span id="progress-tiles"></span>
  <div id="upload-status"></div>
</div>

<div id="viewer-section">
  <h2>Viewer</h2>
  <div class="toolbar">
    <button onclick="fitViewer()">Fit</button>
    <button onclick="zoomViewer(-1)">Zoom In</button>
    <button onclick="zoomViewer(1)">Zoom Out</button>
  </div>
  <div id="viewer"></div>
</div>

<?php
$opts = [
    'svg'          => $svgFile,
    'tileSize'     => intval($tileSize),
    'numLevels'    => $numLevels  !== '' ? intval($numLevels)  : null,
    'lowestRes'    => $lowestRes  !== '' ? intval($lowestRes)  : null,
    'highestRes'   => $highestRes !== '' ? intval($highestRes) : null,
    'preRenderAll' => true,
    'background'   => '#ccc',
];
$opts = array_filter($opts, fn($v) => $v !== null);
?>
<script type="module">
  import { FunkySvgViewer } from '../src/index.js';

  const svgName     = <?php echo json_encode($svgName); ?>;
  const serverReady = <?php echo json_encode($serverReady); ?>;
  const progressSec = document.getElementById('progress-section');
  const viewerSec   = document.getElementById('viewer-section');
  const barFill     = document.getElementById('progress-bar-fill');
  const pctLabel    = document.getElementById('progress-pct');
  const tilesLabel  = document.getElementById('progress-tiles');
  const uploadLabel = document.getElementById('upload-status');
  const heading     = document.getElementById('progress-heading');

  if (serverReady) {
    viewerSec.style.display = 'block';
    document.getElementById('render-form').style.opacity = '0.5';
    heading.textContent = 'Loading from server tiles…';

    const viewer = new FunkySvgViewer('#viewer', {
      svg: <?php echo json_encode($svgFile); ?>,
      preRendered: { manifestUrl: '../rasterizationData/' + encodeURIComponent(svgName) + '/manifest.json' },
      background: '#ccc',
    });
    window._viewer = viewer;
    await viewer.mount();
  } else {
    progressSec.style.display = 'block';

  const opts = <?php echo json_encode($opts, JSON_UNESCAPED_SLASHES); ?>;
  console.log('[pre-render] Options:', opts);
  opts.onPreloadProgress = (pct) => {
    barFill.style.width = pct + '%';
    pctLabel.textContent = pct + '%';
  };

  const viewer = new FunkySvgViewer('#viewer', opts);
    window._viewer = viewer;

    viewer.on('loadstart', () => { tilesLabel.textContent = 'Loading SVG…'; });
    viewer.on('load', (d) => { tilesLabel.textContent = `SVG: ${d.width}×${d.height}`; });
    viewer.on('preloadprogress', ({ done, total }) => {
      tilesLabel.textContent = `${done} / ${total} tiles`;
    });

    viewer.on('ready', async () => {
      heading.textContent = 'Uploading tiles to server…';
      tilesLabel.textContent = '';

      const tileCount = viewer._pyramid.totalTiles();
      let uploaded = 0;

      for (let lvl = viewer._pyramid.minLevel; lvl <= viewer._pyramid.maxLevel; lvl++) {
        const cols = viewer._pyramid.colsAt(lvl);
        const rows = viewer._pyramid.rowsAt(lvl);
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const canvas = viewer._cache.getSync
              ? viewer._cache.getSync(lvl, col, row)
              : viewer._cache.get(lvl, col, row);
            if (!canvas || canvas instanceof Promise) continue;

            const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
            if (!blob) continue;

            const fd = new FormData();
            fd.append('svgName', svgName);
            fd.append('level', lvl);
            fd.append('col', col);
            fd.append('row', row);
            fd.append('tile', blob, 'tile.png');

            try {
              await fetch('save-tiles.php', { method: 'POST', body: fd });
            } catch (e) { /* retry? */ }

            uploaded++;
            const pct = Math.round((uploaded / tileCount) * 100);
            barFill.style.width = pct + '%';
            pctLabel.textContent = pct + '%';
            uploadLabel.textContent = `Uploaded ${uploaded} / ${tileCount} tiles`;
          }
        }
      }

      const manifest = {
        svgName,
        svgWidth: viewer._pyramid.svgWidth,
        svgHeight: viewer._pyramid.svgHeight,
        tileSize: viewer._pyramid.tileSize,
        minLevel: viewer._pyramid.minLevel,
        maxLevel: viewer._pyramid.maxLevel,
        numLevels: viewer._pyramid.numLevels,
        totalTiles: tileCount,
        tileFormat: 'png',
      };

      await fetch('save-tiles.php?manifest=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });

      heading.textContent = 'Done! Tiles saved to server.';
      uploadLabel.textContent = 'Reload the page to load from server tiles.';
      progressSec.style.display = 'none';
      viewerSec.style.display = 'block';
    });

    await viewer.mount();
  }

  window.fitViewer = () => window._viewer?.fitToViewport();
  window.zoomViewer = (dir) => {
    const v = window._viewer;
    if (v) v.zoomTo(v.getState().zoom * (dir > 0 ? 1.5 : 1 / 1.5));
  };
</script>
</body>
</html>