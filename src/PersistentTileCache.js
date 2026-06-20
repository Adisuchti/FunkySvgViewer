import { IndexedDBTileStore } from './IndexedDBTileStore.js';

/**
 * Combines an in-memory LRU cache with IndexedDB persistence.
 *
 * - set() writes to both memory and IndexedDB
 * - get() checks memory first, falls back to IndexedDB (promoting to memory)
 * - has() checks memory, then IndexedDB
 * - clear() wipes both
 *
 * When a tile is loaded from IndexedDB (cache miss in memory), it is
 * promoted into the LRU cache so subsequent accesses are fast.
 */
export class PersistentTileCache {
  /**
   * @param {import('./TileCache.js').TileCache} lruCache
   * @param {IndexedDBTileStore} idbStore
   */
  constructor(lruCache, idbStore) {
    this._lru = lruCache;
    this._idb = idbStore;
    /** Track pending IDB loads to prevent duplicate fetches */
    this._pending = new Map();
  }

  /**
   * Get a tile (sync check memory, async fallback to IDB).
   * Returns the canvas immediately if in memory, or a Promise<canvas|undefined>.
   *
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {HTMLCanvasElement|undefined|Promise<HTMLCanvasElement|undefined>}
   */
  get(level, col, row) {
    // Check memory first
    const mem = this._lru.get(level, col, row);
    if (mem) return mem;

    // Check if already loading
    const key = this._lru.key(level, col, row);
    if (this._pending.has(key)) return this._pending.get(key);

    // Load from IDB asynchronously
    const promise = this._idb.get(level, col, row).then(canvas => {
      this._pending.delete(key);
      if (canvas) {
        this._lru.set(level, col, row, canvas);
        return canvas;
      }
      return undefined;
    });
    this._pending.set(key, promise);
    return promise;
  }

  /**
   * Synchronously get a tile from memory only (no IDB fallback).
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {HTMLCanvasElement|undefined}
   */
  getSync(level, col, row) {
    return this._lru.get(level, col, row);
  }

  /**
   * Store a tile in both memory and IndexedDB.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @param {HTMLCanvasElement} canvas
   */
  set(level, col, row, canvas) {
    this._lru.set(level, col, row, canvas);
    // Fire-and-forget IDB write (don't block rendering)
    this._idb.set(level, col, row, canvas).catch(() => {});
  }

  /**
   * Check if a tile exists (memory first, then IDB).
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {boolean|Promise<boolean>}
   */
  has(level, col, row) {
    if (this._lru.has(level, col, row)) return true;
    return this._idb.has(level, col, row);
  }

  /** Current memory cache size. */
  get size() { return this._lru.size; }

  key(level, col, row) { return this._lru.key(level, col, row); }

  clear() {
    this._lru.clear();
    this._pending.clear();
    this._idb.clear().catch(() => {});
  }
}