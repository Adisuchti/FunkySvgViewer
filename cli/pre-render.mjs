#!/usr/bin/env node

/**
 * Server-side SVG tile pre-renderer with file-size optimizations.
 *
 * Performance strategy (CRITICAL for speed):
 *   - Renders each pyramid level ONCE (full SVG at level resolution)
 *   - Extracts all tiles from that single render via sharp .extract()
 *
 * This means a 6-level pyramid costs 6 SVG rasterizations total,
 * NOT (1+4+16+64+256+1024) = 1365 separate renders per tile.
 *
 * File-size optimizations:
 *   --format png|webp       Choose output image format (default: png)
 *   --palette               (PNG only) ≤256-color palette quantization
 *   --bitdepth 4|2|1        Reduce color channel bit depth (presets)
 *   Single-color tiles      Always-on: file-less, stored in manifest
 *
 * Usage:
 *   node cli/pre-render.mjs Altis_Map.svg \
 *     --tileSize 256 \
 *     --numLevels 6 \
 *     --lowestRes 4096 \
 *     --highestRes 40960
 *   node cli/pre-render.mjs Altis_Map.svg --format webp
 *   node cli/pre-render.mjs Altis_Map.svg --format png --palette --bitdepth 4
 *
 * Requires: npm install sharp
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';
import sharp from 'sharp';

// ── Argument parsing ──────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node pre-render.mjs <svgFile> [options]');
  console.error('Options:');
  console.error('  --tileSize=N       Tile dimensions in pixels (default: 256)');
  console.error('  --numLevels=N      Number of pyramid levels');
  console.error('  --lowestRes=N      Full-SVG pixel width at coarsest level');
  console.error('  --highestRes=N     Full-SVG pixel width at finest level');
  console.error('  --outDir=PATH      Output base directory (default: ./rasterizationData)');
  console.error('  --maxCanvasDim=N   Canvas cap for auto level calculation (default: 4096)');
  console.error('  --format=png|webp  Output image format (default: png)');
  console.error('  --webpQuality=N    WebP quality 1-100 (default: 90)');
  console.error('  --palette          (PNG only) Quantize to ≤256-color palette');
  console.error('  --bitdepth=4|2|1   Reduce color channel bit depth (presets)');
  process.exit(1);
}

const svgPath = resolve(args[0]);
const svgName = basename(svgPath, extname(svgPath));

function argVal(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const tileSize     = parseInt(argVal('--tileSize', '256'), 10);
const numLevels    = argVal('--numLevels')      ? parseInt(argVal('--numLevels'), 10)    : undefined;
const lowestRes    = argVal('--lowestRes')      ? parseInt(argVal('--lowestRes'), 10)    : undefined;
const highestRes   = argVal('--highestRes')     ? parseInt(argVal('--highestRes'), 10)   : undefined;
const outBaseDir   = resolve(argVal('--outDir', './rasterizationData'));
const maxCanvasDim = parseInt(argVal('--maxCanvasDim', '4096'), 10);

// ── Optimization options ─────────────────────────────────────────
const format      = argVal('--format', 'png');
const webpQuality = Math.max(1, Math.min(100, parseInt(argVal('--webpQuality', '90'), 10)));
const usePalette  = hasFlag('--palette') && format === 'png';
const bitdepthArg = argVal('--bitdepth', null);
const bitShift    = bitdepthArg ? (8 - parseInt(bitdepthArg, 10)) : 0;

const useWebP = format === 'webp';
if (useWebP && usePalette) {
  console.warn('Warning: --palette is only for PNG. Ignoring for WebP output.');
}

const fileExt = useWebP ? '.webp' : '.png';

// ── Read SVG ──────────────────────────────────────────────────────
const svgBuffer = readFileSync(svgPath);
const svgString = svgBuffer.toString('utf-8');

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

// ── Compute tile pyramid ──────────────────────────────────────────
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

// ── Output directories ────────────────────────────────────────────
const svgOutDir = join(outBaseDir, svgName);
const tilesDir  = join(svgOutDir, 'tiles');
mkdirSync(tilesDir, { recursive: true });

// ── Manifest ──────────────────────────────────────────────────────
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
  tileFormat: format,
  optimization: {
    format,
    singleColorDetection: true,
  },
  singleColorTiles: {},
};
if (useWebP) manifest.optimization.webpQuality = webpQuality;
if (usePalette) manifest.optimization.palette = true;
if (bitShift > 0) manifest.optimization.bitdepth = bitdepthArg;

// ── Per-level rendered images ─────────────────────────────────────
const levelImages = new Map();

async function renderFullLevel(level) {
  if (levelImages.has(level)) {
    return sharp(levelImages.get(level));
  }
  const cols = Math.pow(2, level);
  const fullW = tileSize * cols;
  const density = (fullW / svgWidth) * 72;
  console.log(`  Rasterizing full level ${level}: ${fullW}×${Math.round(fullW * (svgHeight / svgWidth))}px`);
  const buf = await sharp(svgBuffer, { density })
    .resize(fullW, Math.round(fullW * (svgHeight / svgWidth)), { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  levelImages.set(level, buf);
  return sharp(buf.data, {
    raw: { width: buf.info.width, height: buf.info.height, channels: 4 },
  });
}

async function extractTile(fullLevelSharp, col, row, _level) {
  const tileX = col * tileSize;
  const tileY = row * tileSize;
  return fullLevelSharp
    .clone()
    .extract({ left: tileX, top: tileY, width: tileSize, height: tileSize });
}

/**
 * Detect if a tile is entirely one solid color.
 */
async function detectSolidColor(tileSharp) {
  const { data } = await tileSharp.clone().raw().toBuffer({ resolveWithObject: true });
  const pixels = data;
  if (pixels.length === 0) return null;

  let firstOpaqueR = -1, firstOpaqueG = -1, firstOpaqueB = -1, firstOpaqueA = -1;
  let found = false;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a === 0) continue;
    if (!found) {
      firstOpaqueR = r; firstOpaqueG = g; firstOpaqueB = b; firstOpaqueA = a;
      found = true;
      continue;
    }
    if (r !== firstOpaqueR || g !== firstOpaqueG || b !== firstOpaqueB || a !== firstOpaqueA) {
      return null;
    }
  }
  if (!found) return '#00000000';
  return `#${firstOpaqueR.toString(16).padStart(2, '0')}${firstOpaqueG.toString(16).padStart(2, '0')}${firstOpaqueB.toString(16).padStart(2, '0')}${firstOpaqueA.toString(16).padStart(2, '0')}`;
}

async function encodeTile(tileSharp) {
  let pipeline = tileSharp.clone();

  if (useWebP) {
    pipeline = pipeline.webp({ quality: webpQuality });
  } else {
    if (usePalette) {
      pipeline = pipeline.png({ palette: true, colors: 256 });
    } else {
      pipeline = pipeline.png();
    }
    if (bitShift > 0) {
      const targetDepth = 8 - bitShift;
      pipeline = pipeline.png({
        palette: usePalette,
        colors: usePalette ? 256 : undefined,
        bitdepth: targetDepth,
        compressionLevel: 9,
      });
    }
  }

  return pipeline.toBuffer();
}

// ── Rasterize all tiles ───────────────────────────────────────────
console.log(`SVG: ${svgWidth}×${svgHeight}, pyramid: levels ${pyramid.minLevel}–${pyramid.maxLevel} (${pyramid.levels.length} levels, ${manifest.totalTiles} tiles total)`);
console.log(`Output: ${svgOutDir}`);
console.log(`Format: ${format.toUpperCase()}${useWebP ? ` (q=${webpQuality})` : usePalette ? ' (palette)' : ''}${bitShift > 0 ? ` (bitdepth=${bitdepthArg})` : ''}`);
console.log(`Strategy: 1 SVG render per level, extract all tiles, single-color detection\n`);

let totalDone = 0;
let totalSingleColor = 0;
let totalRendered = 0;

for (const { level, cols, rows } of pyramid.levels) {
  const totalThisLevel = cols * rows;
  console.log(`\n── Level ${level}: ${cols}×${rows} = ${totalThisLevel} tiles ──`);

  const fullImg = await renderFullLevel(level);
  let levelRendered = 0;
  let levelSingleColor = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = `L${level}-R${row}-C${col}`;
      const outFile = join(tilesDir, `${key}${fileExt}`);

      const tileSharp = await extractTile(fullImg, col, row, level);

      // ── Single-color tile detection (always on) ──────────────────
      const solidColor = await detectSolidColor(tileSharp);
      if (solidColor !== null) {
        manifest.singleColorTiles[key] = solidColor;
        levelSingleColor++;
        totalDone++;
        if (totalDone % 100 === 0 || totalDone === manifest.totalTiles) {
          const pct = Math.round((totalDone / manifest.totalTiles) * 100);
          process.stdout.write(`\r  [${pct}%] ${totalDone}/${manifest.totalTiles} tiles (${totalSingleColor + levelSingleColor} sc)`);
        }
        continue;
      }

      // ── Encode and save tile ────────────────────────────────────
      const encodedBuffer = await encodeTile(tileSharp);
      writeFileSync(outFile, encodedBuffer);

      levelRendered++;
      totalDone++;

      if (totalDone % 100 === 0 || totalDone === manifest.totalTiles) {
        const pct = Math.round((totalDone / manifest.totalTiles) * 100);
        process.stdout.write(`\r  [${pct}%] ${totalDone}/${manifest.totalTiles} tiles (${totalSingleColor + levelSingleColor} sc) — ${levelRendered} rendered`);
      }
    }
  }

  totalSingleColor += levelSingleColor;
  totalRendered += levelRendered;
  const savedPct = (levelSingleColor / totalThisLevel * 100).toFixed(1);
  console.log(`\n  Level ${level} done: ${levelRendered} rendered, ${levelSingleColor} single-color (${savedPct}% saved)`);
}

// ── Final manifest ────────────────────────────────────────────────
manifest.actualTileCount = totalRendered;
manifest.singleColorCount = totalSingleColor;

writeFileSync(join(svgOutDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const savingsPct = (totalSingleColor / manifest.totalTiles * 100).toFixed(1);
console.log(`\nDone! ${totalRendered} ${format.toUpperCase()} files saved, ${totalSingleColor} single-color (${savingsPct}% savings).`);

if (pyramid.minLevel === 0) {
  console.log(`    Level 0 = ${1} tile (base)`);
}
for (let lvl = pyramid.minLevel + 1; lvl <= pyramid.maxLevel; lvl++) {
  const totalAtLevel = Math.pow(2, lvl) * Math.pow(2, lvl);
  let scAtLevel = 0;
  for (let r = 0; r < Math.pow(2, lvl); r++) {
    for (let c = 0; c < Math.pow(2, lvl); c++) {
      const key = `L${lvl}-R${r}-C${c}`;
      if (manifest.singleColorTiles[key]) scAtLevel++;
    }
  }
  const bar = '█'.repeat(Math.round((scAtLevel / totalAtLevel) * 30));
  const empty = '░'.repeat(30 - bar.length);
  console.log(`    Level ${lvl} = ${totalAtLevel} tiles: ${bar}${empty} ${scAtLevel}/${totalAtLevel} single-color (${((scAtLevel / totalAtLevel) * 100).toFixed(1)}%)`);
}