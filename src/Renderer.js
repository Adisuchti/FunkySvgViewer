import { TileRasterizer } from './TileRasterizer.js';

/**
 * Tile-based renderer with multi-level detail and multi-layer overlay support.
 *
 * Modes:
 *   1. Client-side lazy             – rasterize tiles on demand (default)
 *   2. Client-side pre-all          – rasterize everything upfront (preRenderAll)
 *   3. Server-pre-rendered single   – load PNG tiles from server (preRenderedLoader)
 *   4. Server-pre-rendered multi    – multiple pre-rendered layers overlaid
 *
 * Multi-layer:
 *   Each layer has its own cache (namespace-isolated). Layers are drawn in order.
 *   For client-side: each layer has its own TileRasterizer.
 *   For pre-rendered: each layer has its own PreRenderedLoader.
 *
 * Supports both sync TileCache and async PersistentTileCache backends.
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {SVGElement|null} _svgElement  - deprecated, kept for signature compat
   * @param {import('./Viewport.js').Viewport} viewport
   * @param {object} deps
   * @param {import('./TilePyramid.js').TilePyramid} deps.pyramid
   * @param {import('./TileCache.js').TileCache} [deps.cache]          — single cache (backward compat)
   * @param {Array<import('./TileCache.js').TileCache|import('./PersistentTileCache.js').PersistentTileCache>} [deps.caches] — per-layer caches
   * @param {import('./LayerManager.js').LayerManager} [deps.layerManager]
   * @param {Array<import('./PreRenderedLoader.js').PreRenderedLoader>} [deps.preRenderedLoaders]
   * @param {Array<{label:string, visible:boolean, width:number, height:number, scaleX?:number, scaleY?:number}>} [deps.prLayerMeta]
   * @param {import('./EventBus.js').EventBus} deps.events
   */
  constructor(canvas, _svgElement, viewport, { pyramid, cache, caches, layerManager, preRenderedLoaders, prLayerMeta, events }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.viewport = viewport;
    this.pyramid = pyramid;
    this.events = events;

    this._bgColor = '#f0f0f0';

    /** @type {Array<import('./TileRasterizer.js').TileRasterizer|null>} per-layer rasterizers (client-side) */
    this._rasterizers = [];

    /** @type {import('./LayerManager.js').LayerManager|null} */
    this._layerManager = layerManager || null;

    /** @type {Array<import('./TileCache.js').TileCache|import('./PersistentTileCache.js').PersistentTileCache>} */
    this._caches = caches || (cache ? [cache] : []);

    if (!caches && cache) {
      this._caches = [cache];
    }

    // ── Pre-rendered state ──
    /** @type {import('./PreRenderedLoader.js').PreRenderedLoader|null} single (backward compat) */
    this._preRenderedLoader = null;
    /** @type {Array<import('./PreRenderedLoader.js').PreRenderedLoader>|null} multi */
    this._preRenderedLoaders = preRenderedLoaders || null;
    /** @type {Array<{label:string, visible:boolean, width:number, height:number, scaleX:number, scaleY:number}>|null} */
    this._prLayerMeta = prLayerMeta || null;

    /** Set of tile keys currently being loaded (prevents duplicate loads) */
    this._pending = new Set();

    this._tileSize = pyramid.tileSize;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.preRenderAll=false]
   * @param {(pct:number)=>void} [opts.onProgress]
   * @param {import('./PreRenderedLoader.js').PreRenderedLoader} [opts.preRenderedLoader]
   * @param {Array<import('./PreRenderedLoader.js').PreRenderedLoader>} [opts.preRenderedLoaders]
   * @param {Array<object>} [opts.prLayerMeta]
   * @param {import('./LayerManager.js').LayerManager} [opts.layerManager]
   * @returns {Promise<void>}
   */
  async prepare(opts = {}) {
    const { preRenderAll = false, onProgress, preRenderedLoader, preRenderedLoaders, prLayerMeta, layerManager } = opts;

    if (layerManager) {
      this._layerManager = layerManager;
    }
    if (prLayerMeta) {
      this._prLayerMeta = prLayerMeta;
    }
    if (preRenderedLoaders) {
      this._preRenderedLoaders = preRenderedLoaders;
    }

    if (preRenderedLoader) {
      // ── Single pre-rendered mode (backward compat) ──
      this._preRenderedLoader = preRenderedLoader;
    } else if (this._preRenderedLoaders && this._preRenderedLoaders.length > 0) {
      // ── Multi-pre-rendered mode ──
      // Loaders are already initialized with loaded manifests
      // Just ensure the first-tile is primed for visible layers
      // (actual tile loading happens lazily in render())
    } else if (this._layerManager) {
      // ── Multi-layer client-side rasterization ──
      const numLayers = this._layerManager.layerCount;
      this._rasterizers = new Array(numLayers).fill(null);

      for (let i = 0; i < numLayers; i++) {
        const svgEl = this._layerManager.getSvgElement(i);
        const dim = this._layerManager.getLayerDimensions(i);
        const scale = this._layerManager.getScale(i);

        const rasterizer = new TileRasterizer(svgEl, this.pyramid, this._tileSize, {
          layerWidth: dim.width,
          layerHeight: dim.height,
          scaleX: scale.scaleX,
          scaleY: scale.scaleY,
        });
        await rasterizer.init();
        this._rasterizers[i] = rasterizer;
      }

      if (preRenderAll) {
        await this._preRenderAllTilesMultiLayer(onProgress);
      } else {
        for (let i = 0; i < numLayers; i++) {
          if (this._layerManager.isVisible(i)) {
            this._ensureTile(0, 0, 0, i);
          }
        }
      }
    }
  }

  /**
   * Set layer visibility (called from FunkySvgViewer for multi-pre-rendered).
   * @param {number} index
   * @param {boolean} visible
   */
  setLayerVisible(index, visible) {
    if (this._prLayerMeta && index < this._prLayerMeta.length) {
      this._prLayerMeta[index].visible = visible;
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

    const halfWorldW = (w / 2) * vp.zoom;
    const halfWorldH = (h / 2) * vp.zoom;
    const worldLeft = vp.centerX - halfWorldW;
    const worldTop = vp.centerY - halfWorldH;
    const worldW = halfWorldW * 2;
    const worldH = halfWorldH * 2;

    const level = this.pyramid.levelForZoom(vp.zoom);
    const tiles = this.pyramid.visibleTiles(level, worldLeft, worldTop, worldW, worldH);

    // ── Path 1: Single pre-rendered (backward compat) ──
    if (this._preRenderedLoader) {
      for (const { col, row } of tiles) {
        this._drawOrLoad(level, col, row);
      }
      return;
    }

    // ── Path 2: Multi-pre-rendered ──
    if (this._preRenderedLoaders && this._prLayerMeta) {
      for (let layerIdx = 0; layerIdx < this._preRenderedLoaders.length; layerIdx++) {
        if (!this._prLayerMeta[layerIdx].visible) continue;

        for (const { col, row } of tiles) {
          this._drawOrLoadPreRenderedLayer(level, col, row, layerIdx);
        }
      }
      return;
    }

    // ── Path 3: Multi-layer client-side rasterization ──
    if (this._rasterizers.length > 0) {
      for (let layerIdx = 0; layerIdx < this._rasterizers.length; layerIdx++) {
        if (!this._layerManager) continue;
        if (!this._layerManager.isVisible(layerIdx)) continue;

        for (const { col, row } of tiles) {
          this._drawOrLoadLayer(level, col, row, layerIdx);
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  //  Multi-pre-rendered layer draw/load
  // ────────────────────────────────────────────────────────────────

  /**
   * Draw or load a tile for a pre-rendered layer.
   */
  _drawOrLoadPreRenderedLayer(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    const loader = this._preRenderedLoaders[layerIdx];
    if (!cache || !loader) return;

    // Sync cache hit?
    const hasResult = cache.has(level, col, row);
    if (hasResult === true) {
      const tileData = cache.get(level, col, row);
      if (tileData && !(tileData instanceof Promise)) {
        this._drawTileCanvas(tileData, level, col, row);
        return;
      }
    }

    // Single-color tile from manifest?
    const solidColor = loader.isSingleColor(level, col, row);
    if (solidColor) {
      const tileCanvas = this._createSingleColorCanvas(solidColor);
      cache.set(level, col, row, tileCanvas);
      this._drawTileCanvas(tileCanvas, level, col, row);
      return;
    }

    // Schedule async load
    this._schedulePreRenderedLoad(level, col, row, layerIdx);

    // Fallback
    this._drawFallbackLayer(level, col, row, layerIdx);
  }

  _schedulePreRenderedLoad(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    if (!cache) return;
    const key = cache.key(level, col, row);
    if (this._pending.has(key)) return;
    this._pending.add(key);

    const loader = this._preRenderedLoaders[layerIdx];
    loader.loadTile(level, col, row).then(canvas => {
      if (canvas === null) {
        cache.set(level, col, row, null);
      } else {
        cache.set(level, col, row, canvas);
      }
      this.events.emit('tileload', { level, col, row, layer: layerIdx });
    }).catch(err => {
      console.error(`[Renderer] Pre-rendered tile load failed L${level} (${col},${row}) layer ${layerIdx}:`, err.message || err);
      this.events.emit('tileerror', { level, col, row, layer: layerIdx, error: err });
    }).finally(() => {
      this._pending.delete(key);
    });
  }

  // ────────────────────────────────────────────────────────────────
  //  Single pre-rendered draw/load (backward compat)
  // ────────────────────────────────────────────────────────────────

  _drawOrLoad(level, col, row) {
    const cache = this._caches[0];

    const hasResult = cache.has(level, col, row);
    if (hasResult === true) {
      const tileData = cache.get(level, col, row);
      if (tileData && !(tileData instanceof Promise)) {
        this._drawTileCanvas(tileData, level, col, row);
        return;
      }
    }

    if (this._preRenderedLoader) {
      const solidColor = this._preRenderedLoader.isSingleColor(level, col, row);
      if (solidColor) {
        const tileCanvas = this._createSingleColorCanvas(solidColor);
        cache.set(level, col, row, tileCanvas);
        this._drawTileCanvas(tileCanvas, level, col, row);
        return;
      }
    }

    if (this._preRenderedLoader) {
      this._loadFromServer(level, col, row);
    }

    this._drawFallback(level, col, row, 0);
  }

  /** Load a tile PNG from the server (single pre-rendered). */
  async _loadFromServer(level, col, row) {
    const cache = this._caches[0];
    const key = cache.key(level, col, row);
    if (this._pending.has(key)) return;
    this._pending.add(key);

    try {
      const canvas = await this._preRenderedLoader.loadTile(level, col, row);
      if (canvas === null) {
        cache.set(level, col, row, null);
      } else {
        cache.set(level, col, row, canvas);
      }
      this.events.emit('tileload', { level, col, row });
    } catch (err) {
      console.error(`[Renderer] Tile load failed L${level} (${col},${row}):`, err.message || err);
      this.events.emit('tileerror', { level, col, row, error: err });
    } finally {
      this._pending.delete(key);
    }
  }

  // ────────────────────────────────────────────────────────────────
  //  Client-side multi-layer draw/load
  // ────────────────────────────────────────────────────────────────

  _drawOrLoadLayer(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    if (!cache) return;

    const hasResult = cache.has(level, col, row);
    if (hasResult === true) {
      const tileData = cache.get(level, col, row);
      if (tileData && !(tileData instanceof Promise)) {
        this._drawTileCanvas(tileData, level, col, row);
        return;
      }
    }

    this._scheduleRasterization(level, col, row, layerIdx);
    this._drawFallbackLayer(level, col, row, layerIdx);
  }

  _scheduleRasterization(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    if (!cache) return;
    const key = cache.key(level, col, row);
    if (this._pending.has(key)) return;
    this._pending.add(key);
    this._ensureTile(level, col, row, layerIdx);
  }

  _ensureTile(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    if (!cache) return;
    const key = cache.key(level, col, row);
    if (cache.has(level, col, row) === true) {
      this._pending.delete(key);
      return;
    }

    const rasterizer = this._rasterizers[layerIdx];
    if (!rasterizer) {
      this._pending.delete(key);
      return;
    }

    requestAnimationFrame(() => {
      try {
        const canvas = rasterizer.rasterize(level, col, row);
        cache.set(level, col, row, canvas);
        this.events.emit('tileload', { level, col, row, layer: layerIdx });
      } catch (err) {
        this.events.emit('tileerror', { level, col, row, layer: layerIdx, error: err });
      } finally {
        this._pending.delete(key);
      }
    });
  }

  // ────────────────────────────────────────────────────────────────
  //  Drawing helpers
  // ────────────────────────────────────────────────────────────────

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

    // Snap start to floor integer, end to ceil integer, then add 1px
    // explicit overlap. This guarantees adjacent tiles overlap by ≥1px
    // regardless of floating-point precision, eliminating stitch gaps.
    const dx = Math.floor(sx) - 1;
    const dy = Math.floor(sy) - 1;
    const dw = Math.ceil(sx + sw) - Math.floor(sx) + 2;
    const dh = Math.ceil(sy + sh) - Math.floor(sy) + 2;

    this.ctx.drawImage(
      tileCanvas,
      0, 0, this._tileSize, this._tileSize,
      dx, dy, dw, dh,
    );
  }

  _createSingleColorCanvas(hexColor) {
    const canvas = document.createElement('canvas');
    canvas.width = this._tileSize;
    canvas.height = this._tileSize;
    const ctx = canvas.getContext('2d');

    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const a = parseInt(hex.substring(6, 8) || 'ff', 16) / 255;

    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // ────────────────────────────────────────────────────────────────
  //  Fallback (walk up pyramid)
  // ────────────────────────────────────────────────────────────────

  _drawFallbackLayer(level, col, row, layerIdx) {
    const cache = this._caches[layerIdx];
    if (!cache) return;

    let bestLevel = level;
    let bestCol = col;
    let bestRow = row;
    const floor = this.pyramid.minLevel;

    while (bestLevel >= floor) {
      const h = cache.has(bestLevel, bestCol, bestRow);
      if (h === true) {
        const fbCanvas = cache.getSync
          ? cache.getSync(bestLevel, bestCol, bestRow)
          : cache.get(bestLevel, bestCol, bestRow);
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

  _drawFallback(level, col, row, cacheIdx) {
    const cache = this._caches[cacheIdx];
    if (!cache) return;

    let bestLevel = level;
    let bestCol = col;
    let bestRow = row;
    const floor = this.pyramid.minLevel;

    while (bestLevel >= floor) {
      const h = cache.has(bestLevel, bestCol, bestRow);
      if (h === true) {
        const fbCanvas = cache.getSync
          ? cache.getSync(bestLevel, bestCol, bestRow)
          : cache.get(bestLevel, bestCol, bestRow);
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

    // Same floor+ceil+2px overlap pattern as _drawTileCanvas
    const rdx = Math.floor(dx) - 1;
    const rdy = Math.floor(dy) - 1;
    const rdw = Math.ceil(dx + dw) - Math.floor(dx) + 2;
    const rdh = Math.ceil(dy + dh) - Math.floor(dy) + 2;

    this.ctx.drawImage(fbCanvas, sx, sy, sw, sh, rdx, rdy, rdw, rdh);
  }

  // ────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ────────────────────────────────────────────────────────────────

  destroy() {
    this._rasterizers = [];
    this._preRenderedLoader = null;
    this._preRenderedLoaders = null;
    this._prLayerMeta = null;
    this._pending.clear();
  }

  // ────────────────────────────────────────────────────────────────
  //  Pre-render-all (client-side multi-layer)
  // ────────────────────────────────────────────────────────────────

  async _preRenderAllTilesMultiLayer(onProgress) {
    const numLayers = this._rasterizers.length;
    let done = 0;
    let total = 0;

    for (let i = 0; i < numLayers; i++) {
      if (this._layerManager.isVisible(i)) {
        total += this.pyramid.totalTiles();
      }
    }
    if (total === 0) return;

    const emit = () => {
      if (onProgress) onProgress(Math.round((done / total) * 100));
      this.events.emit('preloadprogress', { done, total });
    };

    for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
      if (!this._layerManager.isVisible(layerIdx)) continue;
      const rasterizer = this._rasterizers[layerIdx];
      const cache = this._caches[layerIdx];
      if (!rasterizer || !cache) continue;

      for (let level = this.pyramid.minLevel; level <= this.pyramid.maxLevel; level++) {
        const cols = this.pyramid.colsAt(level);
        const rows = this.pyramid.rowsAt(level);

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            let hasCached = cache.has(level, col, row);
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
              const canvas = rasterizer.rasterize(level, col, row);
              cache.set(level, col, row, canvas);
              this.events.emit('tileload', { level, col, row, layer: layerIdx });
            } catch (err) {
              this.events.emit('tileerror', { level, col, row, layer: layerIdx, error: err });
            }

            done++;
            emit();
          }
        }
      }
    }

    emit();
  }
}