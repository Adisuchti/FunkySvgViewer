/**
 * Loads pre-rendered tile PNGs/WebPs from a server-side rasterization directory.
 *
 * Expects the directory structure produced by scripts/pre-render.mjs or
 * cli/PreRender (C#):
 *   rasterizationData/<svgName>/
 *     manifest.json
 *     tiles/
 *       L{level}-R{row}-C{col}.{png|webp}
 *
 * Supports file-size optimizations from the manifest:
 *   - Single-color tiles (file-less, rendered as solid canvas)
 *   - Dynamic format detection from manifest.tileFormat
 *   - Cache-busting via query parameter derived from manifest content
 */
export class PreRenderedLoader {
  /**
   * @param {object} options
   * @param {string} options.manifestUrl  - URL to the manifest.json
   * @param {string} [options.baseUrl]    - base URL for tile files.
   *        Default: same directory as manifest.
   */
  constructor({ manifestUrl, baseUrl }) {
    this._manifestUrl = manifestUrl;
    this._baseUrl = baseUrl || this._deriveBase(manifestUrl);
    this._manifest = null;
    this._cacheToken = '';
  }

  /**
   * Fetch the manifest and return pyramid metadata.
   * @returns {Promise<{
   *   svgWidth: number,
   *   svgHeight: number,
   *   tileSize: number,
   *   minLevel: number,
   *   maxLevel: number,
   *   tileFormat: string
   * }>}
   */
  async loadManifest() {
    // Add cache-busting timestamp to prevent stale manifest caching
    const url = this._manifestUrl + '?t=' + Date.now();
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`PreRenderedLoader: HTTP ${resp.status} fetching manifest`);
    }
    this._manifest = await resp.json();
    // Generate a stable cache-busting token from manifest content.
    // This token changes when tiles are regenerated, ensuring the browser
    // refetches tiles even with aggressive caching headers.
    this._cacheToken = this._deriveCacheToken();
    return this._manifest;
  }

  /**
   * Check if a tile is a single-color placeholder (file-less).
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {string|null} hex color string like "#1a2b3cff", or null if not single-color
   */
  isSingleColor(level, col, row) {
    if (!this._manifest || !this._manifest.singleColorTiles) return null;
    const key = `L${level}-R${row}-C${col}`;
    return this._manifest.singleColorTiles[key] || null;
  }

  /**
   * Load a specific tile as an HTMLCanvasElement.
   * - Returns a solid-color canvas for single-color tiles (no network request).
   * - Fetches and draws the image for normal tiles.
   *
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {Promise<HTMLCanvasElement|null>}
   */
  async loadTile(level, col, row) {
    // Check if this tile is a single-color placeholder
    const solidColor = this.isSingleColor(level, col, row);
    if (solidColor) {
      const canvas = document.createElement('canvas');
      const tileSize = this._manifest?.tileSize || 256;
      canvas.width = tileSize;
      canvas.height = tileSize;
      const ctx = canvas.getContext('2d');

      const hex = solidColor.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const a = parseInt(hex.substring(6, 8) || 'ff', 16) / 255;

      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fillRect(0, 0, tileSize, tileSize);
      return canvas;
    }

    // Normal tile - fetch from server with cache-busting query parameter
    const fmt = this._manifest?.tileFormat || 'png';
    const cacheBust = this._cacheToken ? '?v=' + this._cacheToken : '';
    const url = `${this._baseUrl}tiles/L${level}-R${row}-C${col}.${fmt}${cacheBust}`;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
        resolve(canvas);
      };
      img.onerror = () => {
        // Include the URL in the error for easier debugging
        reject(new Error(`PreRenderedLoader: failed to load ${url}`));
      };
      img.src = url;
    });
  }

  /**
   * Derive a stable cache-busting token from manifest properties
   * that change when tiles are regenerated. This ensures browsers
   * refetch tiles even with aggressive caching headers.
   * @returns {string}
   */
  _deriveCacheToken() {
    if (!this._manifest) return '';
    const key = [
      this._manifest.svgName,
      this._manifest.tileSize,
      this._manifest.minLevel,
      this._manifest.maxLevel,
      this._manifest.actualTileCount,
      this._manifest.singleColorCount,
      this._manifest.tileFormat,
    ].join('|');
    // Simple 32-bit hash
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + c;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Derive base URL from manifest URL (strip manifest.json).
   * @param {string} manifestUrl
   * @returns {string}
   */
  _deriveBase(manifestUrl) {
    if (manifestUrl.endsWith('manifest.json')) {
      return manifestUrl.slice(0, -'manifest.json'.length);
    }
    return manifestUrl.replace(/[^/]+$/, '');
  }
}