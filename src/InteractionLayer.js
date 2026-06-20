/**
 * Attaches mouse and touch event listeners to a canvas element,
 * translating them into pan and zoom commands on the Viewport.
 */
export class InteractionLayer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./Viewport.js').Viewport} viewport
   * @param {import('./EventBus.js').EventBus} eventBus
   */
  constructor(canvas, viewport, eventBus) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.eventBus = eventBus;

    /** Is the user currently dragging? */
    this.dragging = false;
    /** Last mouse x in canvas space */
    this.lastX = 0;
    /** Last mouse y in canvas space */
    this.lastY = 0;

    /** For pinch zoom tracking */
    this.lastPinchDist = 0;

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onDblClick = this._onDblClick.bind(this);

    this._attach();
  }

  _attach() {
    const c = this.canvas;
    c.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
    c.addEventListener('touchstart', this._onTouchStart, { passive: false });
    c.addEventListener('touchmove', this._onTouchMove, { passive: false });
    c.addEventListener('touchend', this._onTouchEnd);
    c.addEventListener('contextmenu', this._onContextMenu);
    c.addEventListener('click', this._onClick);
    c.addEventListener('dblclick', this._onDblClick);
  }

  /**
   * Remove all event listeners.
   */
  destroy() {
    const c = this.canvas;
    c.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('touchstart', this._onTouchStart);
    c.removeEventListener('touchmove', this._onTouchMove);
    c.removeEventListener('touchend', this._onTouchEnd);
    c.removeEventListener('contextmenu', this._onContextMenu);
    c.removeEventListener('click', this._onClick);
    c.removeEventListener('dblclick', this._onDblClick);
  }

  /**
   * Get canvas-relative coordinates from a MouseEvent or Touch.
   * @param {MouseEvent|Touch} e
   * @returns {{ x: number, y: number }}
   */
  _canvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /** @param {MouseEvent} e */
  _onMouseDown(e) {
    if (e.button !== 0) return; // Only left button
    this.dragging = true;
    const coords = this._canvasCoords(e);
    this.lastX = coords.x;
    this.lastY = coords.y;
    this.canvas.style.cursor = 'grabbing';
    e.preventDefault();
  }

  /** @param {MouseEvent} e */
  _onMouseMove(e) {
    if (!this.dragging) return;
    const coords = this._canvasCoords(e);
    const dx = coords.x - this.lastX;
    const dy = coords.y - this.lastY;
    this.lastX = coords.x;
    this.lastY = coords.y;

    this.viewport.pan(dx, dy);
    this.eventBus.emit('move', this.viewport.getState());
  }

  /** @param {MouseEvent} e */
  _onMouseUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = 'grab';
  }

  /** @param {WheelEvent} e */
  _onWheel(e) {
    e.preventDefault();
    const coords = this._canvasCoords(e);
    const factor = e.deltaY < 0 ? 0.9 : 1.1;
    this.viewport.zoomAt(factor, coords.x, coords.y, this.canvas.width, this.canvas.height);
    this.eventBus.emit('zoom', this.viewport.getState());
  }

  /** @param {TouchEvent} e */
  _onTouchStart(e) {
    if (e.touches.length === 1) {
      // Single finger — pan
      this.dragging = true;
      const coords = this._canvasCoords(e.touches[0]);
      this.lastX = coords.x;
      this.lastY = coords.y;
    } else if (e.touches.length === 2) {
      // Two fingers — pinch zoom
      this.dragging = false;
      this.lastPinchDist = this._pinchDist(e.touches);
    }
    e.preventDefault();
  }

  /** @param {TouchEvent} e */
  _onTouchMove(e) {
    if (e.touches.length === 1 && this.dragging) {
      const coords = this._canvasCoords(e.touches[0]);
      const dx = coords.x - this.lastX;
      const dy = coords.y - this.lastY;
      this.lastX = coords.x;
      this.lastY = coords.y;
      this.viewport.pan(dx, dy);
      this.eventBus.emit('move', this.viewport.getState());
    } else if (e.touches.length === 2) {
      const newDist = this._pinchDist(e.touches);
      if (this.lastPinchDist > 0) {
        const factor = newDist / this.lastPinchDist;
        // Anchor at midpoint between two touches
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - this.canvas.getBoundingClientRect().left;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - this.canvas.getBoundingClientRect().top;
        this.viewport.zoomAt(factor, midX, midY, this.canvas.width, this.canvas.height);
        this.eventBus.emit('zoom', this.viewport.getState());
      }
      this.lastPinchDist = newDist;
    }
    e.preventDefault();
  }

  /** @param {TouchEvent} _e */
  _onTouchEnd(_e) {
    this.dragging = false;
    this.lastPinchDist = 0;
  }

  /** @param {Event} e */
  _onContextMenu(e) {
    e.preventDefault();
  }

  /** @param {MouseEvent} e */
  _onClick(e) {
    const coords = this._canvasCoords(e);
    const world = this._screenToWorld(coords.x, coords.y);
    this.eventBus.emit('click', {
      screenX: coords.x,
      screenY: coords.y,
      worldX: world.x,
      worldY: world.y,
      originalEvent: e,
    });
  }

  /** @param {MouseEvent} e */
  _onDblClick(e) {
    const coords = this._canvasCoords(e);
    const world = this._screenToWorld(coords.x, coords.y);
    this.eventBus.emit('dblclick', {
      screenX: coords.x,
      screenY: coords.y,
      worldX: world.x,
      worldY: world.y,
      originalEvent: e,
    });
  }

  /**
   * Compute Euclidean distance between two touch points.
   * @param {TouchList} touches
   * @returns {number}
   */
  _pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Convert screen coords to world coords using the current viewport.
   * @param {number} sx
   * @param {number} sy
   * @returns {{ x: number, y: number }}
   */
  _screenToWorld(sx, sy) {
    const vp = this.viewport;
    return {
      x: vp.centerX + (sx - this.canvas.width / 2) * vp.zoom,
      y: vp.centerY + (sy - this.canvas.height / 2) * vp.zoom,
    };
  }
}