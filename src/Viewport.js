import { clamp } from './utils.js';

/**
 * Tracks the viewport state: center position in world space and zoom level.
 * Applies user-configurable constraints.
 */
export class Viewport {
  /**
   * @param {object} options
   * @param {number} options.contentWidth
   * @param {number} options.contentHeight
   * @param {number} [options.minZoom=0.01]
   * @param {number} [options.maxZoom=100]
   * @param {boolean} [options.bounded=true] - constrain pan to content bounds
   */
  constructor({ contentWidth, contentHeight, minZoom = 0.01, maxZoom = 100, bounded = true }) {
    this.contentWidth = contentWidth;
    this.contentHeight = contentHeight;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.bounded = bounded;

    // Center of the content in world coordinates
    this.centerX = contentWidth / 2;
    this.centerY = contentHeight / 2;
    this.zoom = 1;
  }

  /**
   * Apply a relative pan delta in screen pixels, adjusting for current zoom.
   * @param {number} dx - screen pixel delta x
   * @param {number} dy - screen pixel delta y
   */
  pan(dx, dy) {
    // Moving the mouse right means the world should move left under the camera
    this.centerX -= dx * this.zoom;
    this.centerY -= dy * this.zoom;
    this._applyBounds();
  }

  /**
   * Zoom by a factor, anchoring the zoom to a specific point in screen space (relative to canvas).
   * @param {number} factor - multiplicative zoom factor (e.g. 1.1 to zoom in, 0.9 to zoom out)
   * @param {number} anchorX - screen x around which to zoom (0..canvasWidth)
   * @param {number} anchorY - screen y around which to zoom (0..canvasHeight)
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   */
  zoomAt(factor, anchorX, anchorY, canvasWidth, canvasHeight) {
    const oldZoom = this.zoom;
    const newZoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const actualFactor = newZoom / oldZoom;

    // Adjust center so anchor point stays fixed
    // worldPoint = center + (screenPoint - canvasSize/2) * zoom
    // We want the worldPoint at anchor to stay constant.
    const dx = (anchorX - canvasWidth / 2) * (oldZoom - newZoom);
    const dy = (anchorY - canvasHeight / 2) * (oldZoom - newZoom);

    this.centerX += dx;
    this.centerY += dy;
    this.zoom = newZoom;
    this._applyBounds();
  }

  /**
   * Set zoom directly, anchoring at canvas center.
   * @param {number} zoom
   */
  setZoom(zoom) {
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this._applyBounds();
  }

  /**
   * Pan to an absolute world coordinate.
   * @param {number} worldX
   * @param {number} worldY
   */
  panTo(worldX, worldY) {
    this.centerX = worldX;
    this.centerY = worldY;
    this._applyBounds();
  }

  /**
   * Fit the content inside a viewport of given pixel dimensions.
   * @param {number} viewportWidth
   * @param {number} viewportHeight
   * @param {number} [margin=0.95]
   * @returns {{ centerX: number, centerY: number, zoom: number }}
   */
  fitToViewport(viewportWidth, viewportHeight, margin = 0.95) {
    // zoom = world units per screen pixel.
    // To fit contentWidth into viewportWidth:
    //   contentWidth / viewportWidth = world units per pixel.
    const zoom = Math.max(
      (this.contentWidth / viewportWidth) / margin,
      (this.contentHeight / viewportHeight) / margin,
    );
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.centerX = this.contentWidth / 2;
    this.centerY = this.contentHeight / 2;
    this._applyBounds();
    return { centerX: this.centerX, centerY: this.centerY, zoom: this.zoom };
  }

  /**
   * Clamp center to keep content within viewport when bounded mode is enabled.
   */
  _applyBounds() {
    if (!this.bounded) return;

    // In bounded mode we allow the user to pan up to the edge of the content.
    // At high zoom, the viewport shows a smaller area, so the center can roam more widely.
    // Clamp so the viewport never shows empty space beyond the content border.
    // (Using contentWidth / 2 as the minimum and maximum world coordinates for center.)
    // This is a simple implementation; a production version could add padding.

    // Calculate half viewport extent in world space
    // The canvas dimensions aren't known here, so bounds are approximate.
    // We'll enforce bounds in Renderer where canvas size is known.
    // For now, keep center within [0, contentWidth] x [0, contentHeight].
    this.centerX = clamp(this.centerX, 0, this.contentWidth);
    this.centerY = clamp(this.centerY, 0, this.contentHeight);
  }

  /**
   * Get a snapshot of the current viewport state.
   * @returns {{ centerX: number, centerY: number, zoom: number }}
   */
  getState() {
    return {
      centerX: this.centerX,
      centerY: this.centerY,
      zoom: this.zoom,
    };
  }

  /**
   * Restore viewport from a state snapshot.
   * @param {{ centerX: number, centerY: number, zoom: number }} state
   */
  setState(state) {
    this.centerX = state.centerX;
    this.centerY = state.centerY;
    this.zoom = state.zoom;
    this._applyBounds();
  }
}