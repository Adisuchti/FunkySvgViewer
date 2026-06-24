import { SvgLoader } from './SvgLoader.js';

/**
 * Manages multiple SVG layers for overlay rendering.
 *
 * Layer 0 is the "base" layer — it defines the world coordinate system
 * (dimensions, viewport bounds). Overlay layers (index ≥ 1) are
 * automatically scaled (non-uniformly, X and Y independently) to match
 * the base dimensions, so e.g. a 500×500 grid overlay will stretch to
 * fill a 1000×800 base map.
 */
export class LayerManager {
  /**
   * @param {Array<{svg: string|SVGElement, label?: string, visible?: boolean}>} layers
   * @param {boolean} [sanitize=true]
   */
  constructor(layers, sanitize = true) {
    if (!Array.isArray(layers) || layers.length === 0) {
      throw new Error('LayerManager: layers must be a non-empty array');
    }
    this._sanitize = sanitize;

    /** @type {Array<{svg: string|SVGElement, label: string, visible: boolean}>} */
    this._layerDefs = layers.map((l, i) => ({
      svg: l.svg,
      label: l.label || `Layer ${i}`,
      visible: l.visible !== false,  // defaults to true
    }));

    // Populated after load()
    /** @type {number} */
    this.baseWidth = 0;
    /** @type {number} */
    this.baseHeight = 0;
    /** @type {Array<{svgElement: SVGElement, width: number, height: number, scaleX: number, scaleY: number}>} */
    this._loaded = [];
    this._loadedPromise = null;
  }

  /**
   * Load and parse all layer SVGs. Resolves once all are ready.
   * @returns {Promise<void>}
   */
  async load() {
    if (this._loadedPromise) return this._loadedPromise;
    this._loadedPromise = this._doLoad();
    return this._loadedPromise;
  }

  async _doLoad() {
    const loaded = [];

    for (let i = 0; i < this._layerDefs.length; i++) {
      const def = this._layerDefs[i];
      const loader = new SvgLoader(def.svg, this._sanitize);
      const result = await loader.load();
      loaded.push({
        svgElement: result.svgElement,
        width: result.width,
        height: result.height,
        scaleX: 1,
        scaleY: 1,
      });
    }

    // Layer 0 defines the base coordinate system
    const base = loaded[0];
    this.baseWidth = base.width;
    this.baseHeight = base.height;

    // Compute scale transforms for overlay layers
    for (let i = 1; i < loaded.length; i++) {
      const l = loaded[i];
      if (l.width !== this.baseWidth || l.height !== this.baseHeight) {
        l.scaleX = this.baseWidth / l.width;
        l.scaleY = this.baseHeight / l.height;
      }
    }

    this._loaded = loaded;
  }

  /** @returns {number} */
  get layerCount() {
    return this._layerDefs.length;
  }

  /**
   * Get the SVG element for a layer.
   * @param {number} index
   * @returns {SVGElement}
   */
  getSvgElement(index) {
    return this._loaded[index].svgElement;
  }

  /**
   * Get the intrinsic dimensions of a layer's SVG (before scaling).
   * @param {number} index
   * @returns {{ width: number, height: number }}
   */
  getLayerDimensions(index) {
    const l = this._loaded[index];
    return { width: l.width, height: l.height };
  }

  /**
   * Get scale factors to map this layer to the base coordinate system.
   * @param {number} index
   * @returns {{ scaleX: number, scaleY: number }}
   */
  getScale(index) {
    const l = this._loaded[index];
    return { scaleX: l.scaleX, scaleY: l.scaleY };
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  isVisible(index) {
    return this._layerDefs[index].visible;
  }

  /**
   * @param {number} index
   * @param {boolean} visible
   */
  setVisible(index, visible) {
    if (index < 0 || index >= this._layerDefs.length) return;
    this._layerDefs[index].visible = !!visible;
  }

  /**
   * Toggle visibility of a layer.
   * @param {number} index
   * @returns {boolean} new visibility state
   */
  toggle(index) {
    if (index < 0 || index >= this._layerDefs.length) return false;
    this._layerDefs[index].visible = !this._layerDefs[index].visible;
    return this._layerDefs[index].visible;
  }

  /**
   * Get all layer info (for UI).
   * @returns {Array<{index: number, label: string, visible: boolean, width: number, height: number, scaleX: number, scaleY: number}>}
   */
  getLayerInfo() {
    return this._layerDefs.map((def, i) => ({
      index: i,
      label: def.label,
      visible: def.visible,
      width: this._loaded[i]?.width ?? 0,
      height: this._loaded[i]?.height ?? 0,
      scaleX: this._loaded[i]?.scaleX ?? 1,
      scaleY: this._loaded[i]?.scaleY ?? 1,
    }));
  }
}