#!/usr/bin/env node

/**
 * Server-side SVG tile pre-renderer.
 *
 * Reads an SVG, computes the tile pyramid, rasterizes every tile,
 * and saves them as PNG files to:
 *   rasterizationData/<svgName>/tiles/L{level}-R{row}-C{col}.png
 *
 * Also writes a manifest.json with pyramid metadata so the client-side
 * library can load pre-rendered tiles without any client-side rasterization.
 *
 * Usage:
 *   node cli/pre-render.mjs Altis_Map.svg \
 *     --tileSize 256 \
 *     --numLevels 6 \
 *     --lowestRes 4096 \
 *     --highestRes 40960
 *
 * Requires: npm install sharp
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, extname, dirname, join } from 'node:path';
import sharp from 'sharp';

// ── Argument parsing ──────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node pre-render.mjs <svgFile> [options]');
  console.error('Options:');
  console.error('  --tileSize=N     Tile dimensions in pixels (default: 256)');
  console.error('  --numLevels=N    Number of pyramid levels');
  console.error('  --lowestRes=N    Full-SVG像素 width at coarsest level');
  console.error('  --highestRes=N   Full-SVG像素 width at finest level');
  console.error('  --outDir=PATH    Output base directory (default: ./rasterizationData)');
  console.error('  --maxCanvasDim=N Browser canvas cap used for auto-level calc (default: 4096)');
  process.exit(1);
}

const svgPath = resolve(args[0]);
const svgName = basename(svgPath, extname(svgPath));

function argVal(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const tileSize     = parseInt(argVal('--tileSize', '256'), 10);
const numLevels    = argVal('--numLevels')      ? parseInt(argVal('--numLevels'), 10)    : undefined;
const lowestRes    = argVal('--lowestRes')      ? parseInt(argVal('--lowestRes'), 10)    : undefined;
const highestRes   = argVal('--highestRes')     ? parseInt(argVal('--highestRes'), 10)   : undefined;
const outBaseDir   = resolve(argVal('--outDir', './rasterizationData'));
const maxCanvasDim = parseInt(argVal('--maxCanvasDim', '4096'), 10);

// ── Read SVG ──────────────────────────────────────────────────────
const svgBuffer = readFileSync(svgPath);
const svgString = svgBuffer.toString('utf-8');

// Extract viewBox / dimensions from SVG
const viewBoxMatch = svgString.match(/viewBox\s*=\s*["']([^"']+)["']/i);
let svgWidth = 800;
let svgHeight = 600;
if (viewBoxMatch) {
  const parts = viewBoxMatch[1].trim().split(/\s+/);
  if (parts.length === 4) {
    svgWidth  = parseFloat(parts[2]) || svgWidth;
    svgHeight = parseFloat(parts[3]) || svgHeight;
  }
} else {
  const wm = svgString.match(/width\s*=\s*["']?(\d+(?:\.\d+)?)/i);
  const hm = svgString.match(/height\s*=\s*["']?(\d+(?:\.\d+)?)/i);
  if (wm) svgWidth  = parseFloat(wm[1]);
  if (hm) svgHeight = parseFloat(hm[1]);
}

// ── Compute tile pyramid (same logic as TilePyramid.js) ────────────
function computePyramid() {
  let minLevel = 0;
  if (lowestRes !== undefined) {
    minLevel = Math.max(0, Math.ceil(Math.log2(lowestRes / tileSize)));
  }

  let maxLevel;
  if (numLevels !== undefined) {
    maxLevel = minLevel + Math.max(1, numLevels) - 1;
  } else if (highestRes !== undefined) {
    const baseRes = tileSize * Math.pow(2, minLevel);
    if (highestRes <= baseRes) {
      maxLevel = minLevel;
    } else {
      maxLevel = minLevel + Math.ceil(Math.log2(highestRes / baseRes));
    }
  } else {
    let lvl = minLevel;
    while (
      tileSize * Math.pow(2, lvl) < maxCanvasDim &&
      tileSize * Math.pow(2, lvl) < Math.max(svgWidth, svgHeight) * 0.5
    ) {
      lvl++;
    }
    maxLevel = lvl;
  }

  const levels = [];
  for (let lvl = minLevel; lvl <= maxLevel; lvl++) {
    const cols = Math.pow(2, lvl);
    const rows = Math.pow(2, lvl);
    levels.push({ level: lvl, cols, rows });
  }
  return { minLevel, maxLevel, levels };
}

const pyramid = computePyramid();

// ── Output directories ─────────────────────────────────────────────
const svgOutDir = join(outBaseDir, svgName);
const tilesDir  = join(svgOutDir, 'tiles');
mkdirSync(tilesDir, { recursive: true });

// ── Manifest ───────────────────────────────────────────────────────
const manifest = {
  svgName,
  svgWidth,
  svgHeight,
  tileSize,
  minLevel: pyramid.minLevel,
  maxLevel: pyramid.maxLevel,
  numLevels: pyramid.levels.length,
  totalTiles: pyramid.levels.reduce((s, l) => s + l.cols * l.rows, 0),
  levels: pyramid.levels,
  tileFormat: 'png',
};
writeFileSync(join(svgOutDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ── Rasterize all tiles ────────────────────────────────────────────
console.log(`SVG: ${svgWidth}×${svgHeight}, pyramid: levels ${pyramid.minLevel}–${pyramid.maxLevel} (${pyramid.levels.length} levels, ${manifest.totalTiles} tiles total)`);
console.log(`Output: ${svgOutDir}`);

let done = 0;
for (const { level, cols, rows } of pyramid.levels) {
  const tw = svgWidth  / cols;  // world width per tile
  const th = svgHeight / rows;  // world height per tile

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const worldX = col * tw;
      const worldY = row * th;

      // Rasterize this tile:
      // We render the entire SVG scaled such that the tile's world region
      // maps to tileSize×tileSize pixels, then crop/extract that region.
      // sharp can render SVG to a raster at arbitrary size.
      // Approach: render the full SVG at full pyramid resolution for this
      // level (tileSize * cols × tileSize * rows), then extract the tile.
      const fullW = tileSize * cols;
      const fullH = tileSize * rows;
      const tileX = col * tileSize;
      const tileY = row * tileSize;

      const outFile = join(tilesDir, `L${level}-R${row}-C${col}.png`);

      try {
        await sharp(svgBuffer, { density: (fullW / svgWidth) * 72 })
          .resize(fullW, fullH)
          .extract({ left: tileX, top: tileY, width: tileSize, height: tileSize })
          .png()
          .toFile(outFile);
      } catch (err) {
        console.error(`  FAILED L${level}-R${row}-C${col}: ${err.message}`);
        process.exit(1);
      }

      done++;
      if (done % 10 === 0 || done === manifest.totalTiles) {
        const pct = Math.round((done / manifest.totalTiles) * 100);
        process.stdout.write(`\r  [${pct}%] ${done}/${manifest.totalTiles} tiles`);
      }
    }
  }
}

console.log('\nDone!');