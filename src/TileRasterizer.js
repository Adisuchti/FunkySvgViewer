/**
 * Rasterizes a single tile from the SVG element.
 *
 * For each tile at (level, col, row):
 *   1. Create an offscreen canvas at tileSize × tileSize
 *   2. Draw the SVG onto it, clipped to the tile's world-space region
 *   3. Return the canvas
 *
 * Uses an HTMLImageElement preloaded from the SVG for drawing.
 */
export class TileRasterizer {
  /**
   * @param {SVGElement} svgElement
   * @param {import('./TilePyramid.js').TilePyramid} pyramid
   * @param {number} tileSize
   * @param {object} [opts]
   * @param {number} [opts.scaleX=1] - horizontal scale to map overlay SVG coords to base world coords
   * @param {number} [opts.scaleY=1] - vertical scale to map overlay SVG coords to base world coords
   */
  constructor(svgElement, pyramid, tileSize, opts = {}) {
    this.svgElement = svgElement;
    this.pyramid = pyramid;
    this.tileSize = tileSize;
    this.scaleX = opts.scaleX ?? 1;
    this.scaleY = opts.scaleY ?? 1;
    /** Intrinsic width of this layer's SVG (before scaling to base) */
    this.layerWidth = opts.layerWidth ?? pyramid.svgWidth;
    /** Intrinsic height of this layer's SVG (before scaling to base) */
    this.layerHeight = opts.layerHeight ?? pyramid.svgHeight;

    /** Pre-rendered image of the full SVG at a reference resolution */
    this._svgImage = null;
    this._svgImagePromise = null;
  }

  /**
   * Pre-load the SVG as an Image (needed for drawImage calls).
   * @returns {Promise<void>}
   */
  async init() {
    if (this._svgImagePromise) return this._svgImagePromise;
    this._svgImagePromise = new Promise((resolve, reject) => {
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(this.svgElement);
      const blob = new Blob([svgString], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        this._svgImage = img;
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('TileRasterizer: failed to load SVG image'));
      };
      img.src = url;
    });
    return this._svgImagePromise;
  }

  /**
   * Rasterize a specific tile.
   *
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {HTMLCanvasElement}
   */
  rasterize(level, col, row) {
    if (!this._svgImage) {
      throw new Error('TileRasterizer: not initialized — call init() first');
    }

    const ts = this.tileSize;
    const canvas = document.createElement('canvas');
    canvas.width = ts;
    canvas.height = ts;
    const ctx = canvas.getContext('2d');

    // World-space region covered by this tile
    const tw = this.pyramid.tileWorldWidth(level);
    const th = this.pyramid.tileWorldHeight(level);
    const worldX = col * tw;
    const worldY = row * th;

    // Base world dimensions (pyramid is built from the base layer)
    const svgW = this.pyramid.svgWidth;
    const svgH = this.pyramid.svgHeight;

    // Overlay SVG image dimensions: use naturalWidth/Height from the loaded
    // image, falling back to this layer's intrinsic width/height.
    // For the base layer, layerWidth == svgW and layerHeight == svgH.
    // For overlay layers with different dimensions, naturalWidth will be the
    // overlay's own pixel size (e.g. 500×500 for a grid overlay on a 1000×800
    // base). The mapping (worldX / svgW) * overlayImgWidth naturally handles
    // non-uniform scaling — stretching the overlay to fill the base.
    const imgW = this._svgImage.naturalWidth || this.layerWidth;
    const imgH = this._svgImage.naturalHeight || this.layerHeight;

    // Map base-world coords → overlay SVG image pixel coords
    // Formula: fraction of base world * overlay image pixel size
    //   worldX/svgW = 0..1 fraction across base → times overlay pixels
    // This automatically scales non-uniformly in X and Y.
    const sx = (worldX / svgW) * imgW;
    const sy = (worldY / svgH) * imgH;
    const sw = (tw / svgW) * imgW;
    const sh = (th / svgH) * imgH;

    // Draw the tile portion scaled to tileSize×tileSize
    ctx.drawImage(
      this._svgImage,
      sx, sy, sw, sh,          // source rect in the full SVG image
      0, 0, ts, ts,             // dest rect on tile canvas
    );

    return canvas;
  }
}