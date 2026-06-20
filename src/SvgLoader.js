/**
 * Loads SVG content from a URL, inline string, or DOM element.
 * Returns an { svgElement, width, height } object.
 */
export class SvgLoader {
  /**
   * @param {string|SVGElement} source - URL (relative/absolute), inline SVG string, or <svg> element
   * @param {boolean} [sanitize=true] - strip <script> and event handler attributes
   */
  constructor(source, sanitize = true) {
    this.source = source;
    this.sanitize = sanitize;
  }

  /**
   * Load and parse the SVG. Resolves with metadata and a clone of the SVG element.
   * @returns {Promise<{ svgElement: SVGElement, width: number, height: number }>}
   */
  async load() {
    let svgElement;

    if (this.source instanceof SVGElement) {
      svgElement = this.source.cloneNode(true);
    } else if (typeof this.source === 'string') {
      const trimmed = this.source.trim();
      // Heuristic: if starts with '<' it's an inline string, otherwise it's a URL
      if (trimmed.startsWith('<')) {
        svgElement = this._parseString(trimmed);
      } else {
        svgElement = await this._fetchUrl(trimmed);
      }
    } else {
      throw new Error('SvgLoader: source must be a URL string, SVG string, or SVGElement');
    }

    if (this.sanitize) {
      this._sanitize(svgElement);
    }

    const { width, height } = this._extractDimensions(svgElement);
    return { svgElement, width, height };
  }

  /**
   * Parse an inline SVG string into an SVGElement.
   * @param {string} str
   * @returns {SVGElement}
   */
  _parseString(str) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(str, 'image/svg+xml');
    const svg = doc.documentElement;

    // DOMParser returns an <html> wrapper on error — the root is <parsererror>
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('SvgLoader: failed to parse inline SVG string: ' + parseError.textContent);
    }
    return svg;
  }

  /**
   * Fetch an SVG from a URL, return as SVGElement.
   * @param {string} url
   * @returns {Promise<SVGElement>}
   */
  async _fetchUrl(url) {
    // Load via <img> for security (browsers strip scripts in SVG images)
    // Then draw to canvas to extract, or use DOMParser on fetched text.
    // Simpler: use fetch + DOMParser for broad compatibility.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`SvgLoader: HTTP ${response.status} fetching "${url}"`);
    }
    const text = await response.text();
    return this._parseString(text);
  }

  /**
   * Strip <script> elements and event handler attributes.
   * @param {SVGElement} svg
   */
  _sanitize(svg) {
    // Remove <script> elements
    const scripts = svg.querySelectorAll('script');
    for (const script of scripts) {
      script.remove();
    }

    // Remove event handler attributes across all elements
    const allElements = svg.querySelectorAll('*');
    for (const el of allElements) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  /**
   * Determine width and height from SVG viewBox / width / height attributes.
   * Falls back through viewBox → width/height attributes → 800x600.
   * @param {SVGElement} svg
   * @returns {{ width: number, height: number }}
   */
  _extractDimensions(svg) {
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/\s+/);
      if (parts.length === 4) {
        return {
          width: parseFloat(parts[2]) || 800,
          height: parseFloat(parts[3]) || 600,
        };
      }
    }

    // Fall back to width/height attributes
    let width = parseFloat(svg.getAttribute('width'));
    let height = parseFloat(svg.getAttribute('height'));

    // Handle percent / unitless values
    if (!width || Number.isNaN(width)) width = 800;
    if (!height || Number.isNaN(height)) height = 600;

    return { width, height };
  }
}