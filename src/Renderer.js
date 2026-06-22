import { TileRasterizer } from './TileRasterizer.js';

/**
 * Tile-based renderer with multi-level detail.
 *
 * Three modes:
 *   1. Client-side lazy    – rasterize tiles on demand (default)
 *   2. Client-side pre-all  – rasterize everything upfront (preRenderAll)
 *   3. Server-pre-rendered  – load PNG tiles from server (preRenderedLoader)
 *
 * Supports both sync TileCache and async PersistentTileCache backends.
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {SVGElement|null} svgElement  - null when using preRenderedLoader
   * @param {import('./Viewport.js').Viewport} viewport
   * @param {object} deps
   * @param {import('./TilePyramid.js').TilePyramid} deps.pyramid
   * @param {import('./TileCache.js').TileCache|import('./PersistentTileCache.js').PersistentTileCache} deps.cache
   * @param {import('./EventBus.js').EventBus} deps.events
   */
  constructor(canvas, svgElement, viewport, { pyramid, cache, events }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.svgElement = svgElement;
    this.viewport = viewport;
    this.pyramid = pyramid;
    this.cache = cache;
    this.events = events;

    this._bgColor = '#f0f0f0';

    /** @type {TileRasterizer|null} */
    this._rasterizer = null;

    /** @type {import('./PreRenderedLoader.js').PreRenderedLoader|null} */
    this._preRenderedLoader = null;

    /** Set of tile keys currently being loaded (prevents duplicate loads) */
    this._pending = new Set();

    this._tileSize = pyramid.tileSize;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.preRenderAll=false]
   * @param {(pct:number)=>void} [opts.onProgress]
   * @param {import('./PreRenderedLoader.js').PreRenderedLoader} [opts.preRenderedLoader]
   * @returns {Promise<void>}
   */
  async prepare(opts = {}) {
    const { preRenderAll = false, onProgress, preRenderedLoader } = opts;

    if (preRenderedLoader) {
      this._preRenderedLoader = preRenderedLoader;
    } else {
      this._rasterizer = new TileRasterizer(this.svgElement, this.pyramid, this._tileSize);
      await this._rasterizer.init();

      if (preRenderAll) {
        await this._preRenderAllTiles(onProgress);
      } else {
        this._ensureTile(0, 0, 0);
      }
    }
  }

  /**
   * Render the current view. Called every animation frame.
   */
  render() {
    const vp = this.viewport;
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.fillStyle = this._bgColor;
    this.ctx.fillRect(0, 0, w, h);

    if (!this._rasterizer && !this._preRenderedLoader) return;

    const halfWorldW = (w / 2) * vp.zoom;
    const halfWorldH = (h / 2) * vp.zoom;
    const worldLeft = vp.centerX - halfWorldW;
    const worldTop = vp.centerY - halfWorldH;
    const worldW = halfWorldW * 2;
    const worldH = halfWorldH * 2;

    const level = this.pyramid.levelForZoom(vp.zoom);
    const tiles = this.pyramid.visibleTiles(level, worldLeft, worldTop, worldW, worldH);

    for (const { col, row } of tiles) {
      this._drawOrLoad(level, col, row);
    }
  }

  /**
   * Draw a tile (or load from server / rasterize), with fallback.
   */
  _drawOrLoad(level, col, row) {
    // Check if this tile is known-delegated (server-side optimization)
    if (this._preRenderedLoader && this._preRenderedLoader.isDelegated(level, col, row)) {
      const delegation = this._preRenderedLoader.isDelegated(level, col, row);
      const pLevel = delegation.level;
      const pCol = delegation.col;
      const pRow = delegation.row;

      // Check if the explicitly-delegated parent tile is already cached
      const hasParent = this.cache.has(pLevel, pCol, pRow);
      if (hasParent === true) {
        const parentCanvas = this.cache.has(pLevel, pCol, pRow)
          ? (this.cache.getSync
              ? this.cache.getSync(pLevel, pCol, pRow)
              : this.cache.get(pLevel, pCol, pRow))
          : null;
        if (parentCanvas && !(parentCanvas instanceof Promise)) {
          this._blitFallback(parentCanvas, pLevel, pCol, pRow, level, col, row);
          return;
        }
      }

      // Trigger loading of the delegated parent tile so it becomes available
      this._loadFromServer(pLevel, pCol, pRow);

      // Draw generic fallback while the parent tile loads
      this._drawFallback(level, col, row);
      return;
    }

    // Sync cache hit?
    const hasResult = this.cache.has(level, col, row);
    if (hasResult === true) {
      const tileData = this.cache.get(level, col, row);
      if (tileData && !(tileData instanceof Promise)) {
        this._drawTileCanvas(tileData, level, col, row);
        return;
      }
    }

    // Not cached — schedule async load
    if (this._preRenderedLoader) {
      this._loadFromServer(level, col, row);
    } else if (this._rasterizer) {
      this._scheduleRasterization(level, col, row);
    }

    // Fallback: walk up the pyramid looking for a sync memory hit
    this._drawFallback(level, col, row);
  }

  /**
   * Walk up the pyramid to find and draw a coarser fallback tile.
   */
  _drawFallback(level, col, row) {
    let bestLevel = level;
    let bestCol = col;
    let bestRow = row;
    const floor = this.pyramid.minLevel;

    while (bestLevel >= floor) {
      const h = this.cache.has(bestLevel, bestCol, bestRow);
      if (h === true) {
        const fbCanvas = this.cache.getSync
          ? this.cache.getSync(bestLevel, bestCol, bestRow)
          : this.cache.get(bestLevel, bestCol, bestRow);
        if (fbCanvas && !(fbCanvas instanceof Promise)) {
          this._blitFallback(fbCanvas, bestLevel, bestCol, bestRow, level, col, row);
          return;
        }
      }
      bestLevel--;
      bestCol = Math.floor(bestCol / 2);
      bestRow = Math.floor(bestRow / 2);
    }
  }

  /** Load a tile PNG from the server. */
  async _loadFromServer(level, col, row) {
    const key = this.cache.key(level, col, row);
    if (this._pending.has(key)) return;
    this._pending.add(key);

    try {
      const canvas = await this._preRenderedLoader.loadTile(level, col, row);
      if (canvas === null) {
        // Tile is delegated to a parent level — cache null as sentinel
        // so we don't retry it, and the fallback will handle rendering.
        this.cache.set(level, col, row, null);
      } else {
        this.cache.set(level, col, row, canvas);
      }
      this.events.emit('tileload', { level, col, row });
    } catch (err) {
      this.events.emit('tileerror', { level, col, row, error: err });
    } finally {
      this._pending.delete(key);
    }
  }

  /** Schedule a client-side rasterization. */
  _scheduleRasterization(level, col, row) {
    const key = this.cache.key(level, col, row);
    if (this._pending.has(key)) return;
    this._pending.add(key);
    this._ensureTile(level, col, row);
  }

  _ensureTile(level, col, row) {
    const key = this.cache.key(level, col, row);
    if (this.cache.has(level, col, row) === true) {
      this._pending.delete(key);
      return;
    }

    requestAnimationFrame(() => {
      try {
        const canvas = this._rasterizer.rasterize(level, col, row);
        this.cache.set(level, col, row, canvas);
        this.events.emit('tileload', { level, col, row });
      } catch (err) {
        this.events.emit('tileerror', { level, col, row, error: err });
      } finally {
        this._pending.delete(key);
      }
    });
  }

  /** Draw a cached tile canvas directly. */
  _drawTileCanvas(tileCanvas, level, col, row) {
    const tw = this.pyramid.tileWorldWidth(level);
    const th = this.pyramid.tileWorldHeight(level);
    const worldX = col * tw;
    const worldY = row * th;

    const vp = this.viewport;
    const sx = (worldX - vp.centerX) / vp.zoom + this.canvas.width / 2;
    const sy = (worldY - vp.centerY) / vp.zoom + this.canvas.height / 2;
    const sw = tw / vp.zoom;
    const sh = th / vp.zoom;

    this.ctx.drawImage(tileCanvas, sx, sy, sw, sh);
  }

  /** Draw a fallback from coarser level, clipped to target tile area. */
  _blitFallback(fbCanvas, fbLevel, fbCol, fbRow, targetLevel, targetCol, targetRow) {
    const targetTW = this.pyramid.tileWorldWidth(targetLevel);
    const targetTH = this.pyramid.tileWorldHeight(targetLevel);
    const targetWorldX = targetCol * targetTW;
    const targetWorldY = targetRow * targetTH;

    const fbTW = this.pyramid.tileWorldWidth(fbLevel);
    const fbTH = this.pyramid.tileWorldHeight(fbLevel);
    const fbWorldX = fbCol * fbTW;
    const fbWorldY = fbRow * fbTH;

    const scale = this._tileSize / fbTW;
    const sx = (targetWorldX - fbWorldX) * scale;
    const sy = (targetWorldY - fbWorldY) * scale;
    const sw = targetTW * scale;
    const sh = targetTH * scale;

    const vp = this.viewport;
    const dx = (targetWorldX - vp.centerX) / vp.zoom + this.canvas.width / 2;
    const dy = (targetWorldY - vp.centerY) / vp.zoom + this.canvas.height / 2;
    const dw = targetTW / vp.zoom;
    const dh = targetTH / vp.zoom;

    this.ctx.drawImage(fbCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  destroy() {
    this._rasterizer = null;
    this._preRenderedLoader = null;
    this._pending.clear();
  }

  // -------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------

  async _preRenderAllTiles(onProgress) {
    const totalTiles = this.pyramid.totalTiles();
    if (totalTiles === 0) return;

    let done = 0;
    const emit = () => {
      if (onProgress) onProgress(Math.round((done / totalTiles) * 100));
      this.events.emit('preloadprogress', { done, total: totalTiles });
    };

    for (let level = this.pyramid.minLevel; level <= this.pyramid.maxLevel; level++) {
      const cols = this.pyramid.colsAt(level);
      const rows = this.pyramid.rowsAt(level);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          // Check cache (supports both sync boolean and async Promise)
          let hasCached = this.cache.has(level, col, row);
          if (hasCached instanceof Promise) hasCached = await hasCached;
          if (hasCached) {
            done++;
            emit();
            continue;
          }

          if (done % 4 === 0) {
            await new Promise(r => requestAnimationFrame(r));
          }

          try {
            const canvas = this._rasterizer.rasterize(level, col, row);
            this.cache.set(level, col, row, canvas);
            this.events.emit('tileload', { level, col, row });
          } catch (err) {
            this.events.emit('tileerror', { level, col, row, error: err });
          }

          done++;
          emit();
        }
      }
    }

    emit();
  }
}