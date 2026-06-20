# FunkySvgViewer

A JavaScript library for displaying SVG map files with pan & zoom, using tiled multi-resolution rendering via server-pre-rendered PNG tile pyramids. Zero runtime dependencies.

---

## Quick Start

```js
import { FunkySvgViewer } from 'funky-svg-viewer';

const viewer = new FunkySvgViewer('#container', {
  svg: './floorplan.svg', // URL, inline string, or SVGElement
});

viewer.mount();
```

### With a CDN / `<script>` tag (IIFE build)

```html
<script src="dist/funky-svg-viewer.iife.js"></script>
<script>
  const viewer = new FunkySvgViewer('#container', { svg: './image.svg' });
  viewer.mount();
</script>
```

---

## Demo

The demo (`index.html`) loads pre-rendered PNG tiles from `rasterizationData/`. The repository does **not** include the SVG map file or pre-rendered tile data — you must generate them first.

### 1. Place an SVG file in the project root (e.g. `Altis_Map.svg`)

### 2. Pre-render tiles via the CLI

```bash
npm run pre-render -- Altis_Map.svg --numLevels 6 --lowestRes 4096
```

This creates `rasterizationData/Altis_Map/manifest.json` and all tile PNGs.

### 3. Open the demo

Edit `index.html` to point at your SVG and manifest, then:

```bash
npm run serve
# → http://localhost:3000
```

Alternatively, use `admin/pre-render.php` for a browser-based pre-render + upload workflow that rasterizes tiles client-side.

---

## Features

| Feature | Status |
| ------- | ------ |
| Load SVG from URL, inline string, or `<svg>` element | ✅ |
| Tile pyramid — multi-resolution rendering at discrete zoom levels | ✅ |
| Lazy tile rasterization — tiles generated on demand, on first visibility | ✅ |
| Fallback tiles — coarser-level tiles shown while finer ones load | ✅ |
| In-memory tile cache with LRU eviction | ✅ |
| Server-side pre-rendered PNG tiles via manifest | ✅ |
| IndexedDB persistent tile cache | ✅ |
| Pre-render all tiles upfront (`preRenderAll`) | ✅ |
| Mouse drag to pan | ✅ |
| Mouse wheel to zoom (anchored at cursor) | ✅ |
| Touch single-finger drag + two-finger pinch zoom | ✅ |
| Button controls (zoom in/out, fit) | ✅ |
| Event system (`loadstart`, `load`, `ready`, `move`, `zoom`, `click`, `dblclick`, `tileload`, `tileerror`, `preloadprogress`) | ✅ |
| SVG-world coordinates in click events | ✅ |
| Responsive resize (ResizeObserver) | ✅ |
| XSS sanitization (strips `<script>`, `on*` attributes) | ✅ |
| Configurable zoom bounds, tile size, pyramid levels, and background color | ✅ |
| `fitToViewport()`, `panTo()`, `zoomTo()` programmatic API | ✅ |
| Zero runtime dependencies | ✅ |

### Known Limitations

- **No Worker rasterization** — heavy SVGs rasterize on the main thread via `requestAnimationFrame` batching. Large pyramids may cause jank during initial pre-rendering.
- **No animated SVGs** — SMIL / CSS animations are not rendered (static raster only).
- **No overlay API** — markers and custom elements on top of the SVG are planned.
- **No TypeScript declarations** — plain JavaScript with JSDoc annotations.
- **No inertia panning** — pan stops immediately on mouse/touch release.

---

## API

### Constructor

```ts
new FunkySvgViewer(container: string | HTMLElement, options: Options)
```

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `svg` (required) | `string \| SVGElement` | — | URL, inline SVG string, or `<svg>` DOM element |
| `sanitize` | `boolean` | `true` | Strip `<script>` and event handler attributes |
| `minZoom` | `number` | `0.01` | Minimum zoom level (world units per screen pixel) |
| `maxZoom` | `number` | `100` | Maximum zoom level |
| `bounded` | `boolean` | `true` | Constrain panning to content bounds |
| `background` | `string` | `'#f0f0f0'` | CSS color for the canvas background |
| `tileSize` | `number` | `256` | Tile dimensions in pixels |
| `maxCanvasDim` | `number` | `4096` | Maximum canvas dimension for auto-level calculation |
| `cacheSize` | `number` | `256` | Maximum tiles in the in-memory LRU cache |
| `minLevel` | `number` | `0` | Coarsest pyramid level |
| `numLevels` | `number` | — | Exact number of pyramid levels (overrides `highestRes`) |
| `lowestRes` | `number` | — | Full-SVG pixel width at the coarsest level (shifts `minLevel`) |
| `highestRes` | `number` | — | Full-SVG pixel width at the finest level (derives `numLevels`) |
| `preRenderAll` | `boolean` | `false` | Rasterize every tile at startup instead of lazily |
| `cacheBackend` | `'memory' \| 'indexeddb'` | `'memory'` | Tile cache storage backend |
| `preRendered` | `string \| { manifestUrl: string, baseUrl?: string }` | — | Load pre-rendered PNG tiles from a server manifest |
| `onPreloadProgress` | `(pct: number) => void` | — | Progress callback during `preRenderAll` |

### Methods

| Method | Description |
| ------ | ----------- |
| `mount()` | Load SVG, start rendering. Returns `Promise<void>`. |
| `on(event, fn)` | Subscribe to an event. |
| `off(event, fn)` | Unsubscribe from an event. |
| `panTo(x, y)` | Pan to world coordinates. |
| `zoomTo(zoom)` | Set absolute zoom level. |
| `fitToViewport()` | Fit the entire SVG within the container. |
| `getState()` | Returns `{ centerX, centerY, zoom }`. |
| `destroy()` | Remove all listeners, DOM elements, and stop rendering. |

### Events

| Event | Payload |
| ----- | ------- |
| `loadstart` | _none_ |
| `load` | `{ width, height }` — SVG dimensions |
| `ready` | _none_ — first frame rendered |
| `move` | `{ centerX, centerY, zoom }` — viewport state after pan |
| `zoom` | `{ centerX, centerY, zoom }` — viewport state after zoom |
| `click` | `{ screenX, screenY, worldX, worldY, originalEvent }` |
| `dblclick` | `{ screenX, screenY, worldX, worldY, originalEvent }` |
| `tileload` | `{ level, col, row }` — tile successfully loaded/cached |
| `tileerror` | `{ level, col, row, error }` — tile loading failed |
| `preloadprogress` | `{ done, total }` — progress during `preRenderAll` |

---

## Server-Side Pre-Rendering

For large SVGs, rasterization can be done at build time on the server. Pre-rendered tiles are saved as PNGs and loaded by the client with zero client-side rasterization cost.

### 1. Generate tiles

```bash
node cli/pre-render.mjs Altis_Map.svg \
  --tileSize 256 \
  --numLevels 6 \
  --lowestRes 4096 \
  --highestRes 40960
```

**Options:**

| Flag | Description | Default |
| ---- | ----------- | ------- |
| `--tileSize=N` | Tile dimensions in pixels | `256` |
| `--numLevels=N` | Number of pyramid levels | _auto_ |
| `--lowestRes=N` | Full-SVG pixel width at coarsest level | — |
| `--highestRes=N` | Full-SVG pixel width at finest level | — |
| `--outDir=PATH` | Output base directory | `./rasterizationData` |
| `--maxCanvasDim=N` | Browser canvas cap for auto-level calculation | `4096` |

Output structure:
```
rasterizationData/<svgName>/
  manifest.json
  tiles/
    L0-R0-C0.png
    L1-R0-C0.png
    L1-R0-C1.png
    …
```

### 2. Load pre-rendered tiles on the client

```js
const viewer = new FunkySvgViewer('#container', {
  svg: './Altis_Map.svg',
  preRendered: 'rasterizationData/Altis_Map/manifest.json',
});
viewer.mount();
```

Or with explicit base URL:
```js
preRendered: {
  manifestUrl: '/tiles/manifest.json',
  baseUrl: '/tiles/',
}
```

---

## IndexedDB Caching

Enable persistent tile storage so tiles survive page reloads:

```js
const viewer = new FunkySvgViewer('#container', {
  svg: './Altis_Map.svg',
  cacheBackend: 'indexeddb',
});
```

Tiles are stored as PNG blobs in IndexedDB under the database `funky-svg-viewer-tiles`, keyed by SVG name and tile coordinates. On subsequent `mount()` calls, previously rasterized tiles load from IndexedDB instead of being re-rasterized.

---

## Architecture

```
src/
├── index.js              # Public entry point (re-exports FunkySvgViewer)
├── FunkySvgViewer.js     # Core class — orchestrates everything
├── EventBus.js           # Simple pub/sub event system
├── SvgLoader.js          # Fetches / parses SVG source
├── Viewport.js           # Tracks center & zoom, applies bounds
├── InteractionLayer.js   # Mouse & touch → pan/zoom commands
├── Renderer.js           # Tile-based renderer with multi-level detail & fallback
├── TilePyramid.js        # Computes zoom levels and tile coordinates
├── TileCache.js          # In-memory LRU tile cache
├── TileRasterizer.js     # Rasterizes a single tile from the SVG element
├── PersistentTileCache.js# Two-tier cache (memory → IndexedDB)
├── IndexedDBTileStore.js # IndexedDB read/write for tile PNG blobs
├── PreRenderedLoader.js  # Loads server-pre-rendered PNG tiles via manifest
└── utils.js              # Math helpers (clamp, screen↔world, fitZoom)
```

### Rendering Pipeline

1. User pans/zooms → Viewport updated.
2. Renderer computes the best pyramid level for the current zoom.
3. Visible tile set is determined for the current viewport.
4. For each visible tile:
   - Check cache (memory or IndexedDB).
   - Cache miss → rasterize on client or fetch from server.
   - While loading, a coarser-level fallback tile is displayed.
5. Renderer draws all visible tiles onto the display canvas.
6. Tiles leaving the viewport are evicted from the display but kept in cache.

### Tile Pyramid

```
Zoom 0:  1 tile   (covers entire SVG)
Zoom 1:  4 tiles  (2×2)
Zoom 2: 16 tiles  (4×4)
…
Zoom N: (2^N × 2^N) tiles
```

Each level doubles the pixel density of the previous one. Levels are computed from `minLevel`, `numLevels`/`highestRes`/`lowestRes`, or auto-capped by `maxCanvasDim`.

---

## Development

```bash
# Install dependencies
npm install

# Build ESM + CJS bundles
npm run build

# Dev mode with watch
npm run dev

# Build IIFE for <script> tag usage
npm run demo

# Serve the demo page
npm run serve

# Pre-render tiles server-side
npm run pre-render -- Altis_Map.svg --numLevels 6 --lowestRes 4096

# Run tests
npm test

# Lint & format
npm run lint
npm run format
```

---

## License

MIT