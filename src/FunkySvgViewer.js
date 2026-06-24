import { EventBus } from './EventBus.js';
import { SvgLoader } from './SvgLoader.js';
import { LayerManager } from './LayerManager.js';
import { Viewport } from './Viewport.js';
import { InteractionLayer } from './InteractionLayer.js';
import { Renderer } from './Renderer.js';
import { TilePyramid } from './TilePyramid.js';
import { TileCache } from './TileCache.js';
import { PersistentTileCache } from './PersistentTileCache.js';
import { IndexedDBTileStore } from './IndexedDBTileStore.js';
import { PreRenderedLoader } from './PreRenderedLoader.js';

/**
 * Default configuration.
 */
const DEFAULT_OPTIONS = {
  sanitize: true,
  minZoom: 0.01,
  maxZoom: 100,
  bounded: true,
  background: '#f0f0f0',
  tileSize: 256,
  maxCanvasDim: 4096,
  cacheSize: 256,
  minLevel: 0,
  preRenderAll: false,
  cacheBackend: 'memory',  // 'memory' | 'indexeddb'
  // layers: [{ svg, label, visible }]   — new multi-layer API
  // svg: '...'                          — backward-compat single-layer API
  // numLevels, lowestRes, highestRes: undefined = auto-compute
  // preRendered: undefined
};

export class FunkySvgViewer {
  /**
   * @param {string|HTMLElement} container
   * @param {object} options
   * @param {string|SVGElement} [options.svg]                         — single-layer (backward compat)
   * @param {Array<{svg: string|SVGElement, label?: string, visible?: boolean}>} [options.layers] — multi-layer
   * @param {boolean} [options.sanitize=true]
   * @param {number} [options.minZoom=0.01]
   * @param {number} [options.maxZoom=100]
   * @param {boolean} [options.bounded=true]
   * @param {string} [options.background='#f0f0f0']
   * @param {number} [options.tileSize=256]
   * @param {number} [options.maxCanvasDim=4096]
   * @param {number} [options.cacheSize=256]
   * @param {number} [options.minLevel=0]
   * @param {number} [options.numLevels]
   * @param {number} [options.lowestRes]
   * @param {number} [options.highestRes]
   * @param {boolean} [options.preRenderAll=false]
   * @param {(pct:number)=>void} [options.onPreloadProgress]
   * @param {'memory'|'indexeddb'} [options.cacheBackend='memory']
   * @param {string|{manifestUrl:string, baseUrl?:string}} [options.preRendered]
   */
  constructor(container, options) {
    this._container = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    if (!this._container) throw new Error('FunkySvgViewer: container not found');

    this._options = { ...DEFAULT_OPTIONS, ...options };

    // ── Determine layer source ──
    const hasLayers = this._options.layers && Array.isArray(this._options.layers) && this._options.layers.length > 0;
    const hasSvg = !!this._options.svg;
    const hasPreRenderedLayers = this._options.preRenderedLayers && Array.isArray(this._options.preRenderedLayers) && this._options.preRenderedLayers.length > 0;

    if (hasLayers) {
      this._isMultiLayer = true;
    } else if (hasSvg) {
      // Wrap single SVG as a layers array for uniform handling (only if not preRenderedLayers mode)
      if (!hasPreRenderedLayers) {
        this._options.layers = [{ svg: this._options.svg }];
      }
      this._isMultiLayer = false;
    } else if (hasPreRenderedLayers) {
      // preRenderedLayers mode doesn't need svg/layers
      this._isMultiLayer = false;
    } else {
      throw new Error('FunkySvgViewer: either "svg", "layers", or "preRenderedLayers" option is required');
    }

    // ── Determine rendering mode ──
    if (this._options.preRenderedLayers && Array.isArray(this._options.preRenderedLayers) && this._options.preRenderedLayers.length > 0) {
      // ── Multi-layer pre-rendered mode ──
      this._preRenderedConfigs = this._options.preRenderedLayers.map(cfg =>
        typeof cfg === 'string' ? { manifestUrl: cfg } : { ...cfg }
      );
      this._preRenderedConfig = null;
      this._isMultiPreRendered = true;
    } else if (this._options.preRendered) {
      // ── Single pre-rendered mode (backward compat) ──
      const pr = this._options.preRendered;
      this._preRenderedConfig = typeof pr === 'string' ? { manifestUrl: pr } : { ...pr };
      this._preRenderedConfigs = null;
      this._isMultiPreRendered = false;
    } else {
      this._preRenderedConfig = null;
      this._preRenderedConfigs = null;
      this._isMultiPreRendered = false;
    }

    this.events = new EventBus();

    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.style.cursor = 'grab';

    this._viewport = null;
    this._interaction = null;
    this._renderer = null;
    this._pyramid = null;
    /** @type {LayerManager|null} */
    this._layerManager = null;
    /** @type {Array<TileCache|PersistentTileCache>} per-layer caches */
    this._layerCaches = [];
    this._idbStore = null;
    /** @type {PreRenderedLoader|null} single pre-rendered (backward compat) */
    this._preRenderedLoader = null;
    /** @type {Array<PreRenderedLoader>|null} multi-pre-rendered loaders */
    this._preRenderedLoaders = null;
    /** @type {Array<{label:string, visible:boolean, width:number, height:number, scaleX:number, scaleY:number}>} layer metadata for pre-rendered overlays */
    this._prLayerMeta = [];
    this._rafId = null;
    this._mounted = false;
  }

  async mount() {
    if (this._mounted) return;

    let width, height, svgIdentifier;

    if (this._isMultiPreRendered && this._preRenderedConfigs) {
      // ── Multi-layer pre-rendered mode ──
      this.events.emit('loadstart');
      const configs = this._preRenderedConfigs;

      // Load all manifests in parallel
      const loaders = configs.map(cfg => new PreRenderedLoader(cfg));
      const manifests = await Promise.all(loaders.map(l => l.loadManifest()));

      // Layer 0 (base) defines the coordinate system
      const baseManifest = manifests[0];
      width = baseManifest.svgWidth;
      height = baseManifest.svgHeight;
      svgIdentifier = baseManifest.svgName + '+overlays';

      this._options.tileSize   = baseManifest.tileSize   ?? this._options.tileSize;
      this._options.minLevel   = baseManifest.minLevel   ?? 0;
      this._options.maxLevel   = baseManifest.maxLevel;
      this._options.numLevels  = baseManifest.numLevels;

      this._preRenderedLoaders = loaders;

      // Build layer metadata for toggles & scaling
      this._prLayerMeta = manifests.map((m, i) => ({
        label: m.svgName || `Layer ${i}`,
        visible: true,
        width: m.svgWidth,
        height: m.svgHeight,
        levels: (m.maxLevel ?? 0) - (m.minLevel ?? 0) + 1,
        tileCount: m.actualTileCount ?? m.totalTiles ?? 0,
      }));

      // Compute scale for overlay layers (non-uniform stretch to base)
      for (let i = 1; i < this._prLayerMeta.length; i++) {
        const l = this._prLayerMeta[i];
        l.scaleX = width / l.width;
        l.scaleY = height / l.height;
      }
      this._prLayerMeta[0].scaleX = 1;
      this._prLayerMeta[0].scaleY = 1;

      this.events.emit('load', { width, height });
    } else if (this._preRenderedConfig) {
      this._preRenderedLoader = new PreRenderedLoader(this._preRenderedConfig);
      this.events.emit('loadstart');
      const manifest = await this._preRenderedLoader.loadManifest();
      width = manifest.svgWidth;
      height = manifest.svgHeight;
      svgIdentifier = manifest.svgName;

      // Override pyramid options from the manifest so the client-side
      // TilePyramid matches the pre-rendered tile set exactly.
      this._options.tileSize   = manifest.tileSize   ?? this._options.tileSize;
      this._options.minLevel   = manifest.minLevel   ?? 0;
      this._options.maxLevel   = manifest.maxLevel;
      this._options.numLevels  = manifest.numLevels;
      this.events.emit('load', { width, height });
    } else {
      // ── Load all layers via LayerManager ──
      this._layerManager = new LayerManager(this._options.layers, this._options.sanitize);
      this.events.emit('loadstart');
      await this._layerManager.load();
      width = this._layerManager.baseWidth;
      height = this._layerManager.baseHeight;

      // Derive SVG identifier from first layer's file name
      const firstSvg = this._options.layers[0].svg;
      svgIdentifier = typeof firstSvg === 'string'
        ? firstSvg.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
        : 'inline-svg';
      this.events.emit('load', { width, height });
    }

    this._container.appendChild(this._canvas);
    this._resizeCanvas();

    this._viewport = new Viewport({
      contentWidth: width,
      contentHeight: height,
      minZoom: this._options.minZoom,
      maxZoom: this._options.maxZoom,
      bounded: this._options.bounded,
    });
    this._viewport.fitToViewport(this._canvas.clientWidth, this._canvas.clientHeight);

    if ((this._preRenderedLoader || this._preRenderedLoaders) && this._options.maxLevel !== undefined) {
      // Build pyramid from manifest values (exact match with pre-rendered tiles)
      this._pyramid = new TilePyramid({
        svgWidth: width,
        svgHeight: height,
        tileSize: this._options.tileSize,
        minLevel: this._options.minLevel,
        numLevels: this._options.maxLevel - this._options.minLevel + 1,
        maxCanvasDim: this._options.maxCanvasDim,
      });
    } else {
      // Build pyramid from user options or auto-compute
      this._pyramid = new TilePyramid({
        svgWidth: width,
        svgHeight: height,
        tileSize: this._options.tileSize,
        minLevel: this._options.minLevel,
        numLevels: this._options.numLevels,
        lowestRes: this._options.lowestRes,
        highestRes: this._options.highestRes,
        maxCanvasDim: this._options.maxCanvasDim,
      });
    }

    // ── Set up per-layer caches ──
    if (this._isMultiPreRendered && this._preRenderedLoaders) {
      // Multi-pre-rendered: per-layer caches
      await this._setupPreRenderedLayerCaches(svgIdentifier);
    } else if (!this._preRenderedLoader) {
      // Client-side multi-layer rasterization path
      await this._setupMultiLayerCaches(width, height, svgIdentifier);
    } else {
      // Pre-rendered single-layer path (unchanged)
      const tilesAtMinLevel = this._pyramid.colsAt(this._pyramid.minLevel)
                            * this._pyramid.rowsAt(this._pyramid.minLevel);
      const lruSize = this._options.preRenderAll
        ? Math.max(this._options.cacheSize, this._pyramid.totalTiles())
        : Math.max(this._options.cacheSize, tilesAtMinLevel);
      const lru = new TileCache(lruSize);

      if (this._options.cacheBackend === 'indexeddb') {
        this._idbStore = new IndexedDBTileStore(svgIdentifier);
        this._cache = new PersistentTileCache(lru, this._idbStore);
      } else {
        this._cache = lru;
      }
      this._layerCaches = [this._cache];
    }

    // ── Create Renderer ──
    if (this._isMultiPreRendered && this._preRenderedLoaders) {
      this._renderer = new Renderer(this._canvas, null, this._viewport, {
        pyramid: this._pyramid,
        caches: this._layerCaches,
        preRenderedLoaders: this._preRenderedLoaders,
        prLayerMeta: this._prLayerMeta,
        events: this.events,
      });
    } else if (this._preRenderedLoader) {
      this._renderer = new Renderer(this._canvas, null, this._viewport, {
        pyramid: this._pyramid,
        cache: this._cache,
        caches: this._layerCaches,
        events: this.events,
      });
    } else {
      this._renderer = new Renderer(this._canvas, null, this._viewport, {
        pyramid: this._pyramid,
        caches: this._layerCaches,
        layerManager: this._layerManager,
        events: this.events,
      });
    }
    this._renderer._bgColor = this._options.background;

    if (this._isMultiPreRendered && this._preRenderedLoaders) {
      await this._renderer.prepare({
        preRenderAll: false,
        preRenderedLoaders: this._preRenderedLoaders,
        prLayerMeta: this._prLayerMeta,
        onProgress: this._options.onPreloadProgress,
      });
    } else if (this._preRenderedLoader) {
      await this._renderer.prepare({
        preRenderAll: false,
        preRenderedLoader: this._preRenderedLoader,
        onProgress: this._options.onPreloadProgress,
      });
    } else {
      await this._renderer.prepare({
        preRenderAll: this._options.preRenderAll,
        onProgress: this._options.onPreloadProgress,
        layerManager: this._layerManager,
      });
    }

    this._interaction = new InteractionLayer(this._canvas, this._viewport, this.events);

    this._resizeObserver = new ResizeObserver(() => {
      this._resizeCanvas();
    });
    this._resizeObserver.observe(this._container);

    this._mounted = true;
    this._startLoop();

    this.events.emit('ready');
  }

  /**
   * Create per-layer caches with namespace isolation for multi-pre-rendered layers.
   */
  async _setupPreRenderedLayerCaches(svgIdentifier) {
    const numLayers = this._preRenderedLoaders.length;
    const tilesAtMinLevel = this._pyramid.colsAt(this._pyramid.minLevel)
                          * this._pyramid.rowsAt(this._pyramid.minLevel);
    const lruSize = Math.max(this._options.cacheSize, tilesAtMinLevel);

    for (let i = 0; i < numLayers; i++) {
      const namespace = `PRL${i}`;
      const lru = new TileCache(lruSize, namespace);

      if (this._options.cacheBackend === 'indexeddb') {
        const storeName = `${svgIdentifier}_prlayer${i}`;
        const idbStore = new IndexedDBTileStore(storeName);
        const persistent = new PersistentTileCache(lru, idbStore);
        this._layerCaches.push(persistent);
      } else {
        this._layerCaches.push(lru);
      }
    }

    this._cache = this._layerCaches[0];
  }

  /**
   * Create per-layer caches with namespace isolation (client-side rasterization).
   */
  async _setupMultiLayerCaches(width, height, svgIdentifier) {
    const numLayers = this._layerManager.layerCount;
    const tilesAtMinLevel = this._pyramid.colsAt(this._pyramid.minLevel)
                          * this._pyramid.rowsAt(this._pyramid.minLevel);
    const lruSize = this._options.preRenderAll
      ? Math.max(this._options.cacheSize, this._pyramid.totalTiles())
      : Math.max(this._options.cacheSize, tilesAtMinLevel);

    for (let i = 0; i < numLayers; i++) {
      const namespace = `L${i}`;
      const lru = new TileCache(lruSize, namespace);

      if (this._options.cacheBackend === 'indexeddb') {
        const storeName = `${svgIdentifier}_layer${i}`;
        const idbStore = new IndexedDBTileStore(storeName);
        const persistent = new PersistentTileCache(lru, idbStore);
        this._layerCaches.push(persistent);
      } else {
        this._layerCaches.push(lru);
      }
    }

    // Keep backward-compat _cache reference pointing to layer 0
    this._cache = this._layerCaches[0];
  }

  // ── Public API ──────────────────────────────────────────────────

  on(event, fn) { this.events.on(event, fn); }
  off(event, fn) { this.events.off(event, fn); }

  panTo(x, y) {
    if (this._viewport) {
      this._viewport.panTo(x, y);
      this.events.emit('move', this._viewport.getState());
    }
  }
  zoomTo(zoom) {
    if (this._viewport) {
      this._viewport.setZoom(zoom);
      this.events.emit('zoom', this._viewport.getState());
    }
  }
  fitToViewport() {
    if (this._viewport) {
      this._viewport.fitToViewport(this._canvas.clientWidth, this._canvas.clientHeight);
      this.events.emit('zoom', this._viewport.getState());
    }
  }
  getState() {
    return this._viewport ? this._viewport.getState() : null;
  }

  // ── Layer visibility API ──

  /**
   * Set a layer's visibility.
   * @param {number} index - layer index (0 = base)
   * @param {boolean} visible
   */
  setLayerVisible(index, visible) {
    // Client-side multi-layer path
    if (this._layerManager) {
      this._layerManager.setVisible(index, visible);
      this.events.emit('layerschange', this._layerManager.getLayerInfo());
      return;
    }
    // Multi-pre-rendered path
    if (this._prLayerMeta && index < this._prLayerMeta.length) {
      this._prLayerMeta[index].visible = !!visible;
      if (this._renderer) {
        this._renderer.setLayerVisible(index, visible);
      }
      this.events.emit('layerschange', this.getLayers());
    }
  }

  /**
   * Toggle a layer's visibility.
   * @param {number} index
   * @returns {boolean} new visibility state
   */
  toggleLayer(index) {
    // Client-side multi-layer path
    if (this._layerManager) {
      const newState = this._layerManager.toggle(index);
      this.events.emit('layerschange', this._layerManager.getLayerInfo());
      return newState;
    }
    // Multi-pre-rendered path
    if (this._prLayerMeta && index < this._prLayerMeta.length) {
      const current = this._prLayerMeta[index].visible;
      this.setLayerVisible(index, !current);
      return !current;
    }
    return false;
  }

  /**
   * Get info about all layers (label, visible, dimensions, scale).
   * Supports both client-side and pre-rendered multi-layer modes.
   * @returns {Array<object>}
   */
  getLayers() {
    if (this._layerManager) {
      return this._layerManager.getLayerInfo();
    }
    if (this._prLayerMeta) {
      return this._prLayerMeta.map((l, i) => ({
        index: i,
        label: l.label,
        visible: l.visible,
        width: l.width,
        height: l.height,
        scaleX: l.scaleX ?? 1,
        scaleY: l.scaleY ?? 1,
      }));
    }
    return [];
  }

  destroy() {
    this._stopLoop();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._interaction) { this._interaction.destroy(); this._interaction = null; }
    if (this._renderer) { this._renderer.destroy(); this._renderer = null; }
    for (const cache of this._layerCaches) {
      cache.clear();
    }
    this._layerCaches = [];
    this._cache = null;
    if (this._idbStore) { this._idbStore.clear().catch(() => {}); this._idbStore = null; }

    this._pyramid = null;
    this._layerManager = null;
    this._preRenderedLoader = null;

    if (this._canvas && this._canvas.parentElement) {
      this._canvas.parentElement.removeChild(this._canvas);
    }
    this.events.destroy();
    this._viewport = null;
    this._mounted = false;
  }

  _resizeCanvas() {
    const { width, height } = this._container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = width * dpr;
    this._canvas.height = height * dpr;
    this._canvas.style.width = width + 'px';
    this._canvas.style.height = height + 'px';
  }

  _startLoop() {
    const loop = () => {
      if (!this._mounted) return;
      if (this._renderer) this._renderer.render();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}