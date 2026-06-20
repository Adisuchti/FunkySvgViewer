import { EventBus } from './EventBus.js';
import { SvgLoader } from './SvgLoader.js';
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
  // numLevels, lowestRes, highestRes: undefined = auto-compute
  // preRendered: undefined
};

export class FunkySvgViewer {
  /**
   * @param {string|HTMLElement} container
   * @param {object} options
   * @param {string|SVGElement} options.svg
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

    if (!this._options.svg) throw new Error('FunkySvgViewer: "svg" option is required');

    if (this._options.preRendered) {
      const pr = this._options.preRendered;
      this._preRenderedConfig = typeof pr === 'string' ? { manifestUrl: pr } : { ...pr };
    } else {
      this._preRenderedConfig = null;
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
    this._cache = null;
    this._idbStore = null;
    this._preRenderedLoader = null;
    this._rafId = null;
    this._mounted = false;
  }

  async mount() {
    if (this._mounted) return;

    let width, height, svgElement, svgIdentifier;

    if (this._preRenderedConfig) {
      this._preRenderedLoader = new PreRenderedLoader(this._preRenderedConfig);
      this.events.emit('loadstart');
      const manifest = await this._preRenderedLoader.loadManifest();
      width = manifest.svgWidth;
      height = manifest.svgHeight;
      svgElement = null;
      svgIdentifier = manifest.svgName;

      // Override pyramid options from the manifest so the client-side
      // TilePyramid matches the pre-rendered tile set exactly.
      this._options.tileSize   = manifest.tileSize   ?? this._options.tileSize;
      this._options.minLevel   = manifest.minLevel   ?? 0;
      this._options.maxLevel   = manifest.maxLevel;
      this._options.numLevels  = manifest.numLevels;
      this.events.emit('load', { width, height });
    } else {
      const loader = new SvgLoader(this._options.svg, this._options.sanitize);
      this.events.emit('loadstart');
      const result = await loader.load();
      svgElement = result.svgElement;
      width = result.width;
      height = result.height;
      // Derive SVG identifier from file name (e.g., "Altis_Map" from "Altis_Map.svg")
      const svgSrc = this._options.svg;
      svgIdentifier = typeof svgSrc === 'string'
        ? svgSrc.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
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

    if (this._preRenderedLoader && this._options.maxLevel !== undefined) {
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

    // ---- Set up cache (memory or IndexedDB-backed) ----
    const lruSize = this._options.preRenderAll
      ? Math.max(this._options.cacheSize, this._pyramid.totalTiles())
      : this._options.cacheSize;
    const lru = new TileCache(lruSize);

    if (this._options.cacheBackend === 'indexeddb') {
      this._idbStore = new IndexedDBTileStore(svgIdentifier);
      this._cache = new PersistentTileCache(lru, this._idbStore);
    } else {
      this._cache = lru;
    }

    this._renderer = new Renderer(this._canvas, svgElement, this._viewport, {
      pyramid: this._pyramid,
      cache: this._cache,
      events: this.events,
    });
    this._renderer._bgColor = this._options.background;

    if (this._preRenderedLoader) {
      await this._renderer.prepare({
        preRenderAll: false,
        preRenderedLoader: this._preRenderedLoader,
        onProgress: this._options.onPreloadProgress,
      });
    } else {
      await this._renderer.prepare({
        preRenderAll: this._options.preRenderAll,
        onProgress: this._options.onPreloadProgress,
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

  destroy() {
    this._stopLoop();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._interaction) { this._interaction.destroy(); this._interaction = null; }
    if (this._renderer) { this._renderer.destroy(); this._renderer = null; }
    if (this._cache) { this._cache.clear(); this._cache = null; }
    if (this._idbStore) { this._idbStore.clear().catch(() => {}); this._idbStore = null; }

    this._pyramid = null;
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