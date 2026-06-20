/**
 * Clamp a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between a and b by t.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Convert a screen-space coordinate to world-space based on viewport state.
 * @param {number} screenX - CSS pixel x relative to canvas
 * @param {number} screenY - CSS pixel y relative to canvas
 * @param {number} centerX - World-space x at canvas center
 * @param {number} centerY - World-space y at canvas center
 * @param {number} zoom   - Current zoom factor (world units per screen pixel)
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{ x: number, y: number }}
 */
export function screenToWorld(screenX, screenY, centerX, centerY, zoom, canvasWidth, canvasHeight) {
  return {
    x: centerX + (screenX - canvasWidth / 2) * zoom,
    y: centerY + (screenY - canvasHeight / 2) * zoom,
  };
}

/**
 * Convert a world-space coordinate to screen-space based on viewport state.
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} zoom
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{ x: number, y: number }}
 */
export function worldToScreen(worldX, worldY, centerX, centerY, zoom, canvasWidth, canvasHeight) {
  return {
    x: (worldX - centerX) / zoom + canvasWidth / 2,
    y: (worldY - centerY) / zoom + canvasHeight / 2,
  };
}

/**
 * Calculate the zoom factor needed to fit a rectangle of given dimensions
 * fully within a viewport, with an optional margin ratio.
 * @param {number} contentWidth
 * @param {number} contentHeight
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} [margin=0.95]
 * @returns {number}
 */
export function fitZoom(contentWidth, contentHeight, viewportWidth, viewportHeight, margin = 0.95) {
  if (contentWidth === 0 || contentHeight === 0) return 1;
  return Math.min(
    (viewportWidth / contentWidth) * margin,
    (viewportHeight / contentHeight) * margin,
  );
}