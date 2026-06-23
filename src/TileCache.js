/**
 * LRU cache for tile canvases, keyed by "level,col,row".
 * Evicts least-recently-used tiles when the cache exceeds its max size.
 */
export class TileCache {
  /**
   * @param {number} [maxSize=256] - maximum number of tiles to store
   */
  constructor(maxSize = 256) {
    this._maxSize = maxSize;
    /** @type {Map<string, HTMLCanvasElement>} */
    this._store = new Map();
    /** Track access order for LRU (first = oldest, last = newest) */
    this._accessList = [];
  }

  /**
   * Make a cache key from level, col, row.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {string}
   */
  key(level, col, row) {
    return `${level},${col},${row}`;
  }

  /**
   * Retrieve a tile from the cache (makes it MRU).
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {HTMLCanvasElement|undefined}
   */
  get(level, col, row) {
    const k = this.key(level, col, row);
    if (!this._store.has(k)) return undefined;
    this._touch(k);
    return this._store.get(k);
  }

  /**
   * Store a tile in the cache.  Evicts LRU if needed.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @param {HTMLCanvasElement} canvas
   */
  set(level, col, row, canvas) {
    const k = this.key(level, col, row);
    if (this._store.has(k)) {
      // Update the stored value (in case canvas changed, e.g. from null to a real tile)
      this._store.set(k, canvas);
      this._touch(k);
    } else {
      // Evict oldest if at capacity
      while (this._store.size >= this._maxSize && this._accessList.length > 0) {
        const old = this._accessList.shift();
        this._store.delete(old);
      }
      this._store.set(k, canvas);
      this._accessList.push(k);
    }
  }

  /**
   * Check if a tile exists in the cache (does not change LRU order).
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {boolean}
   */
  has(level, col, row) {
    return this._store.has(this.key(level, col, row));
  }

  /**
   * Remove all cached tiles.
   */
  clear() {
    this._store.clear();
    this._accessList = [];
  }

  /**
   * Current number of cached tiles.
   * @returns {number}
   */
  get size() {
    return this._store.size;
  }

  /**
   * Move a key to the end of the access list (MRU).
   * @param {string} k
   */
  _touch(k) {
    const idx = this._accessList.indexOf(k);
    if (idx !== -1) {
      this._accessList.splice(idx, 1);
    }
    this._accessList.push(k);
  }
}