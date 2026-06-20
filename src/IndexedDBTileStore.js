/**
 * Stores tile canvases in IndexedDB as PNG blobs.
 *
 * Each tile is stored under:
 *   database: "funky-svg-viewer-tiles"
 *   object store: "<svgIdentifier>"  (e.g. "Altis_Map")
 *   key: "L{level}-R{row}-C{col}"
 *
 * On set(), the canvas is converted to a PNG blob and written.
 * On get(), it's read back and converted to an ImageBitmap →
 * drawn onto a fresh canvas.
 */
export class IndexedDBTileStore {
  /**
   * @param {string} svgIdentifier - unique name for this SVG (e.g. "Altis_Map")
   */
  constructor(svgIdentifier) {
    this._dbName = 'funky-svg-viewer-tiles';
    this._storeName = svgIdentifier;
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._ready = this._open();
  }

  /** Open (or create) the database. */
  async _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this._storeName)) {
          db.createObjectStore(this._storeName);
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Store a tile canvas as a PNG blob.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<void>}
   */
  async set(level, col, row, canvas) {
    await this._ready;
    const key = keyFor(level, col, row);

    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) { resolve(); return; }

        const tx = this._db.transaction(this._storeName, 'readwrite');
        const store = tx.objectStore(this._storeName);
        store.put(blob, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }, 'image/png');
    });
  }

  /**
   * Load a tile from IndexedDB, returned as an HTMLCanvasElement.
   * Returns undefined if not found.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {Promise<HTMLCanvasElement|undefined>}
   */
  async get(level, col, row) {
    await this._ready;
    const key = keyFor(level, col, row);

    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this._storeName, 'readonly');
      const store = tx.objectStore(this._storeName);
      const req = store.get(key);

      req.onsuccess = async () => {
        const blob = req.result;
        if (!blob) { resolve(undefined); return; }

        try {
          const bmp = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width  = bmp.width;
          canvas.height = bmp.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          resolve(canvas);
        } catch (err) {
          resolve(undefined);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Check if a tile exists in IndexedDB.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {Promise<boolean>}
   */
  async has(level, col, row) {
    await this._ready;
    const key = keyFor(level, col, row);
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this._storeName, 'readonly');
      const store = tx.objectStore(this._storeName);
      const req = store.count(key);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete a specific tile.
   * @param {number} level
   * @param {number} col
   * @param {number} row
   * @returns {Promise<void>}
   */
  async delete(level, col, row) {
    await this._ready;
    const key = keyFor(level, col, row);
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this._storeName, 'readwrite');
      tx.objectStore(this._storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete the entire store for this SVG.
   * @returns {Promise<void>}
   */
  async clear() {
    await this._ready;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this._storeName, 'readwrite');
      tx.objectStore(this._storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

function keyFor(level, col, row) {
  return `L${level}-R${row}-C${col}`;
}