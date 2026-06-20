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
   */
  constructor(svgElement, pyramid, tileSize) {
    this.svgElement = svgElement;
    this.pyramid = pyramid;
    this.tileSize = tileSize;

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

    const svgW = this.pyramid.svgWidth;
    const svgH = this.pyramid.svgHeight;

    // Compute the source rectangle in the SVG image (image drawn at svgW×svgH)
    // The SVG image dimensions: we draw the full image, so its pixel size
    // equals svgW×svgH (the intrinsic size derived from viewBox or width/height).
    const imgW = this._svgImage.naturalWidth || svgW;
    const imgH = this._svgImage.naturalHeight || svgH;

    // Map world coords → image pixel coords
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