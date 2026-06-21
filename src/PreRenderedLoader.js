/**
 * Loads pre-rendered tile PNGs from a server-side rasterization directory.
 *
 * Expects the directory structure produced by scripts/pre-render.mjs:
 *   rasterizationData/<svgName>/
 *     manifest.json
 *     tiles/
 *       L{level}-R{row}-C{col}.png
 */
export class PreRenderedLoader {
  /**
   * @param {object} options
   * @param {string} options.manifestUrl  - URL to the manifest.json
   * @param {string} [options.baseUrl]    - base URL for tile PNGs.
   *        Default: same directory as manifest.
   */
  constructor({ manifestUrl, baseUrl }) {
    this._manifestUrl = manifestUrl;
    this._baseUrl = baseUrl || this._deriveBase(manifestUrl);
    this._manifest = null;
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
    const resp = await fetch(this._manifestUrl);
    if (!resp.ok) {
      throw new Error(`PreRenderedLoader: HTTP ${resp.status} fetching manifest`);
    }
    this._manifest = await resp.json();
    return this._manifest;
  }

  /**
   * Check if a tile is delegated to a parent level.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {{ level: number, col: number, row: number }|null}
   */
  isDelegated(level, col, row) {
    if (!this._manifest || !this._manifest.delegations) return null;
    const key = `L${level}-R${row}-C${col}`;
    return this._manifest.delegations[key] || null;
  }

  /**
   * Load a specific tile as an HTMLCanvasElement.
   * Returns null if the tile is delegated to a parent level.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {Promise<HTMLCanvasElement|null>}
   */
  async loadTile(level, col, row) {
    // Check if this tile is delegated to a parent — don't even try to fetch
    if (this.isDelegated(level, col, row)) {
      return null;
    }

    const fmt = this._manifest.tileFormat || 'png';
    const url = `${this._baseUrl}tiles/L${level}-R${row}-C${col}.${fmt}`;

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
        reject(new Error(`PreRenderedLoader: failed to load ${url}`));
      };
      img.src = url;
    });
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