/**
 * Computes the tile pyramid structure.
 *
 * Pyramid:
 *   Level 0:  1 tile   (tileSize × tileSize)
 *   Level 1:  2×2 tiles
 *   Level 2:  4×4 tiles
 *   …
 *   Level N: (2^N)×(2^N) tiles
 *
 * Each level doubles the pixel density (pixels per world unit).
 *
 * Configuration (priority order):
 *   1. numLevels      – exact number of levels (wins over highestRes)
 *   2. highestRes     – finest resolution, derives numLevels from ratio
 *   3. auto           – capped by maxCanvasDim
 *
 *   lowestRes        – pixel width of full SVG at the coarsest level.
 *                       Offsets minLevel so tileSize * 2^minLevel >= lowestRes.
 */
export class TilePyramid {
  /**
   * @param {object} options
   * @param {number} options.svgWidth
   * @param {number} options.svgHeight
   * @param {number} [options.tileSize=256]
   * @param {number} [options.minLevel=0]
   * @param {number} [options.numLevels]    – exact number of levels (≥1)
   * @param {number} [options.lowestRes]    – full-SVG pixel width at coarsest level
   * @param {number} [options.highestRes]   – full-SVG pixel width at finest level
   * @param {number} [options.maxCanvasDim=4096]
   */
  constructor({
    svgWidth, svgHeight,
    tileSize = 256,
    minLevel = 0,
    numLevels,
    lowestRes,
    highestRes,
    maxCanvasDim = 4096,
  }) {
    this.svgWidth = svgWidth;
    this.svgHeight = svgHeight;
    this.tileSize = tileSize;

    // ---- Set minLevel from lowestRes if given ----
    if (lowestRes !== undefined) {
      // tileSize * 2^L >= lowestRes  →  L >= log2(lowestRes / tileSize)
      minLevel = Math.max(0, Math.ceil(Math.log2(lowestRes / tileSize)));
    }
    this.minLevel = minLevel;

    // ---- Determine maxLevel ----
    // Priority: numLevels > highestRes > auto

    if (numLevels !== undefined) {
      // Explicit level count wins
      this.maxLevel = minLevel + Math.max(1, numLevels) - 1;
    } else if (highestRes !== undefined) {
      const baseRes = tileSize * Math.pow(2, minLevel);
      if (highestRes <= baseRes) {
        this.maxLevel = minLevel;
      } else {
        const ratio = highestRes / baseRes;
        this.maxLevel = minLevel + Math.ceil(Math.log2(ratio));
      }
    } else {
      // Auto-compute: cap when tileSize * 2^L >= maxCanvasDim
      let lvl = minLevel;
      while (
        tileSize * Math.pow(2, lvl) < maxCanvasDim &&
        tileSize * Math.pow(2, lvl) < Math.max(svgWidth, svgHeight) * 0.5
      ) {
        lvl++;
      }
      this.maxLevel = lvl;
    }
  }

  /** Number of levels. */
  get numLevels() {
    return this.maxLevel - this.minLevel + 1;
  }

  /** Pixel width of the full SVG at a given level. */
  fullWidthPx(level) {
    return this.tileSize * Math.pow(2, level);
  }

  /** Pixel height of the full SVG at a given level. */
  fullHeightPx(level) {
    return this.tileSize * Math.pow(2, level) * (this.svgHeight / this.svgWidth);
  }

  /** Total tiles across all levels. */
  totalTiles() {
    let total = 0;
    for (let lvl = this.minLevel; lvl <= this.maxLevel; lvl++) {
      total += this.colsAt(lvl) * this.rowsAt(lvl);
    }
    return total;
  }

  /** Tile columns at a level. */
  colsAt(level) { return Math.pow(2, level); }

  /** Tile rows at a level. */
  rowsAt(level) { return Math.pow(2, level); }

  /** World width of one tile. */
  tileWorldWidth(level) { return this.svgWidth / this.colsAt(level); }

  /** World height of one tile. */
  tileWorldHeight(level) { return this.svgHeight / this.rowsAt(level); }

  /** Pixels per world unit at a level. */
  worldToTileScale(level) { return this.tileSize / this.tileWorldWidth(level); }

  /**
   * Best pyramid level for a viewport zoom.
   * zoom = world units per screen pixel.
   */
  levelForZoom(zoom) {
    if (zoom <= 0) return this.maxLevel;
    const needed = this.svgWidth / (zoom * this.tileSize);
    let level = Math.ceil(Math.log2(Math.max(1, needed)));
    level = Math.max(this.minLevel, Math.min(this.maxLevel, level));
    return level;
  }

  /**
   * Visible tile indices for a world-space rect at a given level.
   * @returns {Array<{col: number, row: number}>}
   */
  visibleTiles(level, worldLeft, worldTop, worldW, worldH) {
    const tw = this.tileWorldWidth(level);
    const th = this.tileWorldHeight(level);
    const cols = this.colsAt(level);
    const rows = this.rowsAt(level);

    const colStart = Math.max(0, Math.floor(worldLeft / tw));
    const colEnd   = Math.min(cols - 1, Math.floor((worldLeft + worldW) / tw));
    const rowStart = Math.max(0, Math.floor(worldTop / th));
    const rowEnd   = Math.min(rows - 1, Math.floor((worldTop + worldH) / th));

    const tiles = [];
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        tiles.push({ col, row });
      }
    }
    return tiles;
  }
}