#!/usr/bin/env node

/**
 * Server-side SVG tile pre-renderer with quadtree pruning.
 *
 * Performance strategy (CRITICAL for speed):
 *   - Renders each pyramid level ONCE (full SVG at level resolution)
 *   - Extracts all tiles from that single render via sharp .extract()
 *   - Compares each tile against the upscaled parent quadrant
 *   - Cascades delegation: if a tile is delegated, its 4 children are
 *     automatically delegated without rasterization (mathematically correct)
 *
 * This means a 6-level pyramid costs 6 SVG rasterizations total,
 * NOT (1+4+16+64+256+1024) = 1365 separate renders per tile.
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
import { resolve, basename, extname, join } from 'node:path';
import sharp from 'sharp';

// ── Argument parsing ──────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node pre-render.mjs <svgFile> [options]');
  console.error('Options:');
  console.error('  --tileSize=N     Tile dimensions in pixels (default: 256)');
  console.error('  --numLevels=N    Number of pyramid levels');
  console.error('  --lowestRes=N    Full-SVG pixel width at coarsest level');
  console.error('  --highestRes=N   Full-SVG pixel width at finest level');
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
  delegations: {},
};

// ── Per-level rendered images (full rasters of the SVG at each level's resolution) ──
// Key: level number → Buffer (PNG of the entire SVG at that level)
const levelImages = new Map();

/**
 * Render the ENTIRE SVG at a given pyramid level's resolution
 * and return a sharp instance wrapping the result.
 * Cached per level so we do exactly 1 SVG rasterization per level.
 */
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
    .png()
    .toBuffer();

  levelImages.set(level, buf);
  return sharp(buf);
}

/**
 * Extract a single tile from a full-level render.
 */
async function extractTile(fullLevelSharp, col, row, level) {
  const tileX = col * tileSize;
  const tileY = row * tileSize;

  return fullLevelSharp
    .clone()
    .extract({ left: tileX, top: tileY, width: tileSize, height: tileSize });
}

/**
 * Create an upscaled version of the parent tile's quadrant (nearest-neighbor)
 * to compare against the child tile.
 */
async function upscaleParentQuadrant(parentSharp, childCol, childRow) {
  const half = tileSize / 2;
  const qx = (childCol % 2) * half;
  const qy = (childRow % 2) * half;

  return parentSharp
    .clone()
    .extract({ left: Math.round(qx), top: Math.round(qy), width: Math.round(half), height: Math.round(half) })
    .resize(tileSize, tileSize, { kernel: 'nearest' });
}

/**
 * Compare pixel data of two sharp instances. Returns true if identical
 * within a small tolerance (0.1% — accounts for edge filtering differences).
 */
async function tilesAreIdentical(tileA, tileB) {
  const [bufA, bufB] = await Promise.all([
    tileA.clone().raw().toBuffer(),
    tileB.clone().raw().toBuffer(),
  ]);

  if (bufA.length !== bufB.length) return false;

  let diffCount = 0;
  const maxDiffs = bufA.length * 0.001;
  for (let i = 0; i < bufA.length; i++) {
    if (bufA[i] !== bufB[i]) {
      diffCount++;
      if (diffCount > maxDiffs) return false;
    }
  }
  return true;
}

// ── Rasterize all tiles (smart rendering + cascading delegation) ──
console.log(`SVG: ${svgWidth}×${svgHeight}, pyramid: levels ${pyramid.minLevel}–${pyramid.maxLevel} (${pyramid.levels.length} levels, ${manifest.totalTiles} tiles total)`);
console.log(`Output: ${svgOutDir}`);
console.log(`Strategy: 1 SVG render per level, extract all tiles, cascade delegation\n`);

let totalDone = 0;
let totalSkipped = 0;
let totalRendered = 0;

// Track parent tiles that were actually saved (for comparison).
// Key: "L{level}-R{row}-C{col}" → sharp instance
const savedTileSharps = new Map();

// Track which tiles are delegated (to cascade to children).
// Key: "L{level}-R{row}-C{col}" → true
const delegatedSet = new Set();

for (const { level, cols, rows } of pyramid.levels) {
  const totalThisLevel = cols * rows;
  console.log(`\n── Level ${level}: ${cols}×${rows} = ${totalThisLevel} tiles ──`);

  // Render the full SVG at this level ONCE
  const fullImg = await renderFullLevel(level);
  let levelRendered = 0;
  let levelSkipped = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = `L${level}-R${row}-C${col}`;
      const outFile = join(tilesDir, `${key}.png`);

      // ── Cascade delegation: if parent is delegated, child is automatically delegated ──
      if (level > pyramid.minLevel) {
        const parentKey = `L${level - 1}-R${Math.floor(row / 2)}-C${Math.floor(col / 2)}`;
        if (delegatedSet.has(parentKey)) {
          // Parent was delegated → all its children are identical to grandparent quadrant
          manifest.delegations[key] = {
            level: manifest.delegations[parentKey].level,
            col: manifest.delegations[parentKey].col,
            row: manifest.delegations[parentKey].row,
          };
          delegatedSet.add(key);
          levelSkipped++;
          totalDone++;
          if (totalDone % 100 === 0 || totalDone === manifest.totalTiles) {
            const pct = Math.round((totalDone / manifest.totalTiles) * 100);
            process.stdout.write(`\r  [${pct}%] ${totalDone}/${manifest.totalTiles} tiles (${totalSkipped + levelSkipped} skipped, cascaded ${totalSkipped + levelSkipped})`);
          }
          continue;
        }
      }

      // Extract tile from pre-rendered level image
      const tileSharp = await extractTile(fullImg, col, row, level);

      // ── Smart comparison: check if identical to upscaled parent quadrant ──
      if (level > pyramid.minLevel) {
        const parentLevel = level - 1;
        const parentCol = Math.floor(col / 2);
        const parentRow = Math.floor(row / 2);
        const parentKey = `L${parentLevel}-R${parentRow}-C${parentCol}`;

        const parentSharp = savedTileSharps.get(parentKey);
        if (parentSharp) {
          const upscaledQuadrant = await upscaleParentQuadrant(parentSharp, col, row);

          try {
            const identical = await tilesAreIdentical(tileSharp, upscaledQuadrant);
            if (identical) {
              // Skip this tile — identical to parent quadrant
              manifest.delegations[key] = {
                level: parentLevel,
                col: parentCol,
                row: parentRow,
              };
              delegatedSet.add(key);
              levelSkipped++;
              totalDone++;
              if (totalDone % 100 === 0 || totalDone === manifest.totalTiles) {
                const pct = Math.round((totalDone / manifest.totalTiles) * 100);
                process.stdout.write(`\r  [${pct}%] ${totalDone}/${manifest.totalTiles} tiles (${totalSkipped + levelSkipped} skipped)`);
              }
              continue;
            }
          } catch (err) {
            // Comparison failed (e.g. tile size mismatch) – treat as different, save the tile
          }
        }
      }

      // ── Save tile PNG ──────────────────────────────────────────
      await tileSharp.png().toFile(outFile);

      // Store for future comparisons (keep a clone in memory)
      savedTileSharps.set(key, tileSharp);
      levelRendered++;
      totalDone++;

      if (totalDone % 100 === 0 || totalDone === manifest.totalTiles) {
        const pct = Math.round((totalDone / manifest.totalTiles) * 100);
        process.stdout.write(`\r  [${pct}%] ${totalDone}/${manifest.totalTiles} tiles (${totalSkipped + levelSkipped} skipped) — ${levelRendered} rendered this level`);
      }
    }
  }

  totalSkipped += levelSkipped;
  totalRendered += levelRendered;
  console.log(`\n  Level ${level} done: ${levelRendered} rendered, ${levelSkipped} skipped (${((levelSkipped / totalThisLevel) * 100).toFixed(1)}% of level)`);
}

// ── Final manifest ─────────────────────────────────────────────────
manifest.actualTileCount = totalRendered;
manifest.delegationCount = totalSkipped;

writeFileSync(join(svgOutDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\nDone! ${totalRendered} PNGs saved, ${totalSkipped} tiles delegated (${((totalSkipped / manifest.totalTiles) * 100).toFixed(1)}% savings).`);

if (pyramid.minLevel === 0) {
  console.log(`    Level 0 = ${1} tile (base)`);
}
for (let lvl = pyramid.minLevel + 1; lvl <= pyramid.maxLevel; lvl++) {
  const totalAtLevel = Math.pow(2, lvl) * Math.pow(2, lvl);
  let delegatedAtLevel = 0;
  for (let r = 0; r < Math.pow(2, lvl); r++) {
    for (let c = 0; c < Math.pow(2, lvl); c++) {
      if (delegatedSet.has(`L${lvl}-R${r}-C${c}`)) delegatedAtLevel++;
    }
  }
  const bar = '█'.repeat(Math.round((delegatedAtLevel / totalAtLevel) * 30));
  const empty = '░'.repeat(30 - bar.length);
  console.log(`    Level ${lvl} = ${totalAtLevel} tiles: ${bar}${empty} ${delegatedAtLevel}/${totalAtLevel} delegated (${((delegatedAtLevel / totalAtLevel) * 100).toFixed(1)}%)`);
}