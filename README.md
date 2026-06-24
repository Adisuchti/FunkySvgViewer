This file is AI generated. Sadly, I acknowledge that AI can be useful tool.

# FunkySvgViewer

A JavaScript library for displaying SVG map files with pan & zoom, using tiled multi-resolution rendering via server-pre-rendered PNG tile pyramids. Zero runtime dependencies.
Originally used to display a games maps as SVG files.

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

The demo (`index.html`) loads pre-rendered PNG tiles from `rasterizationData/` and includes a **map selector** dropdown that dynamically fetches available manifests via `admin/list-manifests.php`, with a hardcoded fallback. The repository does **not** include the SVG map file or pre-rendered tile data — you must generate them first.

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

Alternatively, use `admin/pre-render.php` for a browser-based pre-render + upload workflow that rasterizes tiles client-side, compares tiles against their parent quadrant, and only uploads non-identical tiles. Identical tiles are **delegated** to the parent, saving storage and bandwidth.

A tile debug overlay is available at `admin/debug-tiles.html` for visualizing which tiles exist per level with color-coded grid overlays and delegation highlighting.

---

## Features

| Feature |
| ------- |
| Load SVG from URL, inline string, or `<svg>` element |
| Tile pyramid — multi-resolution rendering at discrete zoom levels |
| Lazy tile rasterization — tiles generated on demand, on first visibility |
| Fallback tiles — coarser-level tiles shown while finer ones load |
| In-memory tile cache with LRU eviction |
| Server-side pre-rendered PNG tiles via manifest |
| IndexedDB persistent tile cache |
| Pre-render all tiles upfront (`preRenderAll`) |
| Single-color tile detection — file-less tiles stored as hex colors in manifest, rendered synchronously with zero network requests |
| WebP output support with configurable quality |
| PNG palette quantization (≤256 colors) and configurable color bit depth |
| C# parallel server-side pre-renderer (SkiaSharp) |
| Browser-based smart pre-render + upload with single-color detection (admin panel) |
| Tile debug overlay with per-level coloring (admin panel) |
| Dynamic map switching via dropdown (fetches manifests server-side) |
| Mouse drag to pan |
| Mouse wheel to zoom (anchored at cursor) |
| Touch single-finger drag + two-finger pinch zoom |
| Button controls (zoom in/out, fit) |
| Event system (`loadstart`, `load`, `ready`, `move`, `zoom`, `click`, `dblclick`, `tileload`, `tileerror`, `preloadprogress`) |
| SVG-world coordinates in click events |
| Responsive resize (ResizeObserver) |
| XSS sanitization (strips `<script>`, `on*` attributes) |
| Configurable zoom bounds, tile size, pyramid levels, and background color |
| `fitToViewport()`, `panTo()`, `zoomTo()` programmatic API |
| Zero runtime dependencies |

### Known Limitations

- **No Worker rasterization** — heavy SVGs rasterize on the main thread via `requestAnimationFrame` batching. Large pyramids may cause jank during initial pre-rendering.
- **No animated SVGs** — SMIL / CSS animations are not rendered (static raster only).
- **Single-color tile detection** — tiles that are entirely one solid color are stored file-less as hex colors in the manifest, rendered synchronously on the client with no network request.
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

### 1. Generate tiles (Node.js CLI)

```bash
node cli/pre-render.mjs Altis_Map.svg \
  --tileSize 256 \
  --numLevels 6 \
  --lowestRes 4096 \
  --highestRes 40960

# With format options:
node cli/pre-render.mjs Altis_Map.svg --format webp --webpQuality 85
node cli/pre-render.mjs Altis_Map.svg --format png --palette --bitdepth 4
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
| `--format=png\|webp` | Output image format | `png` |
| `--webpQuality=N` | WebP quality 1–100 (WebP only) | `90` |
| `--palette` | PNG palette quantization (≤256 colors) | — |
| `--bitdepth=4\|2\|1` | Reduce color channel bit depth (PNG only) | — |

**How it works:** Each pyramid level is rasterized once (full SVG at that level's resolution), then all tiles are extracted from that single render. Each tile is scanned for single-color content — if every opaque pixel is identical, the tile is **not saved** to disk. Instead, its color is stored as a hex value in `manifest.json` under `singleColorTiles`. On the client, these tiles are rendered synchronously as solid-color canvases with zero network requests and zero disk space.

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

### 1b. Generate tiles (C# parallel pre-renderer)

A faster alternative using SkiaSharp with strip-based parallel rendering is available in `cli/PreRender/`. Build with `dotnet build` and run:

```bash
dotnet run --project cli/PreRender -- Altis_Map.svg \
  --tileSize 256 \
  --numLevels 6 \
  --lowestRes 4096 \
  --outDir ./rasterizationData

# With format options:
dotnet run --project cli/PreRender -- Altis_Map.svg --format webp --webpQuality 85
dotnet run --project cli/PreRender -- Altis_Map.svg --format png --palette --bitdepth 4
```

Supports the same `--format`, `--webpQuality`, `--palette`, and `--bitdepth` flags as the Node.js CLI, and uses the same single-color tile detection strategy. See `example.txt` for ready-to-run command snippets.

This uses single-color tile detection with multi-threaded tile extraction for significantly faster processing on multi-core machines.

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

### Single-Color Tile Detection

During pre-rendering, every tile is scanned pixel-by-pixel. If all opaque pixels in a tile share the exact same RGBA value, the tile is classified as **single-color** and is **not written to disk**. Instead, its hex color is stored in the manifest:

```json
{
  "singleColorTiles": {
    "L3-R7-C5": "#1a2b3cff",
    "L4-R12-C9": "#00000000"
  }
}
```

This means tile `L3-R7-C5` is entirely solid `#1a2b3c` at full opacity — storing it as a file would waste disk space and bandwidth. Tiles with all-transparent pixels (e.g. `#00000000`) are also captured.

On the client side, `PreRenderedLoader.isSingleColor()` checks the manifest before attempting any network request. If a tile is single-color, the `Renderer` creates a solid-color `<canvas>` synchronously — no fetch, no decode, no cache lookup needed. This is materially faster than delegation because:

- **Zero network requests** — no PNG/WebP file to download
- **Zero disk I/O** — nothing to read from IndexedDB
- **Instant rendering** — solid fill is a single `fillRect()` call
- **No parent dependency** — doesn't require any parent tile to be loaded first

The manifest also carries an `optimization` object recording which format options were used:

```json
{
  "optimization": {
    "format": "webp",
    "webpQuality": 85,
    "singleColorDetection": true
  }
}
```

### Manifest-Driven Cache Busting

`PreRenderedLoader` derives a stable cache-busting token from key manifest fields (SVG name, tile size, levels, format, actualTileCount, singleColorCount). This token is appended as a query parameter (`?v=<hash>`) on all tile requests, ensuring browsers refetch tiles after re-generation even with aggressive caching headers. The token only changes when the manifest content changes.

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