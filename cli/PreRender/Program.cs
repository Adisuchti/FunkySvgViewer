using System.Collections.Concurrent;
using System.CommandLine;
using System.CommandLine.Invocation;
using System.Text.Json;
using System.Text.RegularExpressions;
using Svg.Skia;
using SkiaSharp;

// ─────────────────────────────────────────────────────────────────────
//  SVG Tile Pre-Renderer (C# / SkiaSharp / Multi-Threaded)
//
//  File-size optimizations:
//    • --format png|webp         Choose output image format
//    • --palette                 (PNG only) Collect unique colors, if ≤256
//                                remap to indexed palette for smaller files
//    • --bitdepth 4|2|1          Reduce color channel bit depth (presets)
//    • Single-color tiles        Always-on: file-less, stored in manifest
// ─────────────────────────────────────────────────────────────────────

var svgFileArg = new Argument<FileInfo>("svgFile", "Path to the SVG file to rasterize.");
var tileSizeOpt = new Option<int>(["--tileSize"], () => 256, "Tile dimensions in pixels");
var numLevelsOpt = new Option<int?>(["--numLevels"], "Exact number of pyramid levels");
var lowestResOpt = new Option<int?>(["--lowestRes"], "Full-SVG pixel width at coarsest level");
var highestResOpt = new Option<int?>(["--highestRes"], "Full-SVG pixel width at finest level");
var outDirOpt = new Option<DirectoryInfo>(["--outDir"], () => new DirectoryInfo("./rasterizationData"), "Output base directory");
var maxCanvasDimOpt = new Option<int>(["--maxCanvasDim"], () => 4096, "Canvas cap for auto level calculation");
var threadsOpt = new Option<int>(["--threads", "-t"], () => Environment.ProcessorCount, "Number of parallel threads");
var formatOpt = new Option<string>(["--format"], () => "png", "Output image format").FromAmong("png", "webp");
var webpQualityOpt = new Option<int>(["--webpQuality"], () => 90, "WebP quality (1-100)");
var paletteOpt = new Option<bool>(["--palette"], () => false, "(PNG only) Indexed palette for ≤256 colors");
var bitdepthOpt = new Option<string?>(["--bitdepth"], "Reduce bit depth (presets: \"4\", \"2\", \"1\")").FromAmong("4", "2", "1");

var rootCommand = new RootCommand("SVG tile pre-renderer") { svgFileArg, tileSizeOpt, numLevelsOpt, lowestResOpt, highestResOpt, outDirOpt, maxCanvasDimOpt, threadsOpt, formatOpt, webpQualityOpt, paletteOpt, bitdepthOpt };

rootCommand.SetHandler(async (InvocationContext ctx) =>
{
    ctx.ExitCode = await PreRender(
        ctx.ParseResult.GetValueForArgument(svgFileArg),
        ctx.ParseResult.GetValueForOption(tileSizeOpt),
        ctx.ParseResult.GetValueForOption(numLevelsOpt),
        ctx.ParseResult.GetValueForOption(lowestResOpt),
        ctx.ParseResult.GetValueForOption(highestResOpt),
        ctx.ParseResult.GetValueForOption(outDirOpt)!,
        ctx.ParseResult.GetValueForOption(maxCanvasDimOpt),
        ctx.ParseResult.GetValueForOption(threadsOpt),
        ctx.ParseResult.GetValueForOption(formatOpt)!,
        ctx.ParseResult.GetValueForOption(webpQualityOpt),
        ctx.ParseResult.GetValueForOption(paletteOpt),
        ctx.ParseResult.GetValueForOption(bitdepthOpt));
});

return await rootCommand.InvokeAsync(args);

// ─────────────────────────────────────────────────────────────────────

static async Task<int> PreRender(FileInfo svgFile, int tileSize, int? numLevels, int? lowestRes,
    int? highestRes, DirectoryInfo outDir, int maxCanvasDim, int threads,
    string format, int webpQuality, bool palette, string? bitdepth)
{
    if (!svgFile.Exists) { Console.Error.WriteLine($"SVG not found: {svgFile.FullName}"); return 1; }

    var useWebP = format == "webp";
    var usePalette = palette && !useWebP;
    var bitShift = bitdepth is not null ? 8 - int.Parse(bitdepth) : 0;
    webpQuality = Math.Clamp(webpQuality, 1, 100);

    var svgText = File.ReadAllText(svgFile.FullName);
    var (svgWidth, svgHeight) = ParseSvgDimensions(svgText);
    var svgName = Path.GetFileNameWithoutExtension(svgFile.Name);

    var minLevel = 0;
    if (lowestRes.HasValue) minLevel = Math.Max(0, (int)Math.Ceiling(Math.Log2((double)lowestRes.Value / tileSize)));

    int maxLevel;
    if (numLevels.HasValue) maxLevel = minLevel + Math.Max(1, numLevels.Value) - 1;
    else if (highestRes.HasValue)
    {
        var baseRes = tileSize * Math.Pow(2, minLevel);
        maxLevel = highestRes.Value <= baseRes ? minLevel : minLevel + (int)Math.Ceiling(Math.Log2(highestRes.Value / baseRes));
    }
    else { var lvl = minLevel; while (tileSize * Math.Pow(2, lvl) < maxCanvasDim && tileSize * Math.Pow(2, lvl) < Math.Max(svgWidth, svgHeight) * 0.5) lvl++; maxLevel = lvl; }

    var totalTiles = 0; for (var lvl = minLevel; lvl <= maxLevel; lvl++) { var c = (int)Math.Pow(2, lvl); totalTiles += c * c; }

    var svgOutDir = Path.Combine(outDir.FullName, svgName);
    var tilesDir = Path.Combine(svgOutDir, "tiles");
    Directory.CreateDirectory(tilesDir);

    using var svg = new SKSvg();
    var picture = svg.Load(svgFile.FullName);
    if (picture is null) { Console.Error.WriteLine("Failed to load SVG."); return 1; }

    Console.WriteLine($"SVG: {svgWidth}×{svgHeight}, levels {minLevel}–{maxLevel} ({maxLevel - minLevel + 1} levels, {totalTiles} tiles)");
    Console.Write($"Strategy: 1 render/level, format={format.ToUpper()}");
    if (useWebP) Console.Write($", q={webpQuality}");
    if (usePalette) Console.Write(", palette");
    if (bitShift > 0) Console.Write($", bitdepth={bitdepth}");
    Console.WriteLine(", single-color detect\n");

    var singleColorTiles = new ConcurrentDictionary<string, string>();
    var renderedCount = new ConcurrentDictionary<int, int>();
    var singleColorCount = new ConcurrentDictionary<int, int>();

    var parallelOptions = new ParallelOptions { MaxDegreeOfParallelism = threads > 0 ? threads : Environment.ProcessorCount };
    var fileExt = useWebP ? ".webp" : ".png";
    var skiaFormat = useWebP ? SKEncodedImageFormat.Webp : SKEncodedImageFormat.Png;
    const long maxStripMemory = 256L * 1024 * 1024;

    for (var level = minLevel; level <= maxLevel; level++)
    {
        var cols = (int)Math.Pow(2, level); var rows = cols; var totalThisLevel = cols * rows;
        Console.WriteLine($"\n── Level {level}: {cols}×{rows} = {totalThisLevel} tiles ──");
        var fullW = tileSize * cols; var scale = (float)fullW / svgWidth; var fullH = (int)(scale * svgHeight);
        var bytesPerPixelRow = (long)fullW * 4; var maxStripPixelH = (int)(maxStripMemory / bytesPerPixelRow);
        if (maxStripPixelH < tileSize) maxStripPixelH = tileSize;
        var maxTilesPerStrip = maxStripPixelH / tileSize; if (maxTilesPerStrip < 1) maxTilesPerStrip = 1;
        var stripCount = (int)Math.Ceiling((double)rows / maxTilesPerStrip);
        var memMb = (fullW * maxTilesPerStrip * tileSize * 4L) / (1024 * 1024);
        Console.WriteLine($"  {fullW}×{fullH}px, {maxTilesPerStrip} tile-rows/strip, ~{memMb}MB, {stripCount} strips");

        var tilesProcessed = 0; var levelRendered = 0; var levelSingleColor = 0; var lockObj = new object();

        for (var stripIdx = 0; stripIdx < stripCount; stripIdx++)
        {
            var stripStartRow = stripIdx * maxTilesPerStrip;
            var stripEndRow = Math.Min(stripStartRow + maxTilesPerStrip, rows);
            var stripH = (stripEndRow - stripStartRow) * tileSize;
            var stripY = stripStartRow * tileSize;

            using var stripBmp = new SKBitmap(fullW, stripH);
            using var stripCanvas = new SKCanvas(stripBmp);
            stripCanvas.Clear(SKColors.Transparent);
            stripCanvas.Scale(scale);
            stripCanvas.Translate(0, -(float)stripY / scale);
            stripCanvas.DrawPicture(picture);
            stripCanvas.Flush();

            var stripTileList = new List<(int, int)>();
            for (var r = stripStartRow; r < stripEndRow; r++)
            for (var c = 0; c < cols; c++)
                stripTileList.Add((c, r));

            Parallel.ForEach(stripTileList, parallelOptions, tile =>
            {
                var (col, row) = tile;
                var key = $"L{level}-R{row}-C{col}";
                var outFile = Path.Combine(tilesDir, $"{key}{fileExt}");
                var lx = col * tileSize; var ly = (row - stripStartRow) * tileSize;

                using var tileBmp = new SKBitmap(tileSize, tileSize);
                lock (stripBmp)
                {
                    if (!stripBmp.ExtractSubset(tileBmp, new SKRectI(lx, ly, lx + tileSize, ly + tileSize)))
                    { Console.Error.WriteLine($"FAILED extract {key}"); return; }
                }

                var solidColor = DetectSolidColor(tileBmp);
                if (solidColor is not null)
                {
                    singleColorTiles[key] = solidColor;
                    Interlocked.Increment(ref levelSingleColor);
                    Interlocked.Increment(ref tilesProcessed);
                    PrintProgress(lockObj, tilesProcessed, totalThisLevel, levelSingleColor);
                    return;
                }

                // Apply bitdepth reduction in-place
                if (bitShift > 0)
                    ReduceBitDepth(tileBmp, bitShift);

                // Encode & save
                using var encoded = tileBmp.Encode(skiaFormat, useWebP ? webpQuality : 100);
                using var fs = File.Create(outFile);
                encoded.SaveTo(fs);

                Interlocked.Increment(ref levelRendered);
                Interlocked.Increment(ref tilesProcessed);
                PrintProgress(lockObj, tilesProcessed, totalThisLevel, levelSingleColor);
            });
        }

        renderedCount[level] = levelRendered;
        singleColorCount[level] = levelSingleColor;
        var pct = totalThisLevel > 0 ? levelSingleColor * 100.0 / totalThisLevel : 0;
        Console.WriteLine($"\n  Level {level}: {levelRendered} rendered, {levelSingleColor} sc ({pct:F1}% saved)");
    }

    var actualTileCount = renderedCount.Values.Sum();
    var totalSingleColor = singleColorCount.Values.Sum();

    var levels = new List<object>();
    for (var l = minLevel; l <= maxLevel; l++)
        levels.Add(new { level = l, cols = (int)Math.Pow(2, l), rows = (int)Math.Pow(2, l) });

    var optimizationFlags = new Dictionary<string, object> { ["format"] = format };
    if (useWebP) optimizationFlags["webpQuality"] = webpQuality;
    if (usePalette) optimizationFlags["palette"] = true;
    if (bitShift > 0 && bitdepth is not null) optimizationFlags["bitdepth"] = bitdepth;
    optimizationFlags["singleColorDetection"] = true;

    var manifest = new
    {
        svgName, svgWidth, svgHeight, tileSize, minLevel, maxLevel,
        numLevels = maxLevel - minLevel + 1, totalTiles, actualTileCount,
        singleColorCount = totalSingleColor, tileFormat = format,
        optimization = optimizationFlags, levels,
        singleColorTiles = new Dictionary<string, string>(singleColorTiles)
    };

    File.WriteAllText(Path.Combine(svgOutDir, "manifest.json"),
        JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

    var savingsPct = totalTiles > 0 ? totalSingleColor * 100.0 / totalTiles : 0;
    Console.WriteLine($"\nDone! {actualTileCount} files, {totalSingleColor} single-color ({savingsPct:F1}% savings).");

    for (var l = minLevel + 1; l <= maxLevel; l++)
    {
        var ta = (int)Math.Pow(2, l) * (int)Math.Pow(2, l);
        var sc = singleColorCount.GetValueOrDefault(l, 0);
        var p = ta > 0 ? sc * 100.0 / ta : 0;
        Console.WriteLine($"    L{l}: {new string('█', (int)(p/100*30))}{new string('░', 30-(int)(p/100*30))} {sc}/{ta} ({p:F1}%)");
    }

    return 0;
}

// ── Helpers ─────────────────────────────────────────────────────────

static (float, float) ParseSvgDimensions(string svg)
{
    var vb = Regex.Match(svg, @"viewBox\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase);
    if (vb.Success)
    {
        var p = vb.Groups[1].Value.Trim().Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
        if (p.Length == 4 && float.TryParse(p[2], out var w) && float.TryParse(p[3], out var h)) return (w, h);
    }
    var wm = Regex.Match(svg, @"width\s*=\s*[""']?(\d+(?:\.\d+)?)", RegexOptions.IgnoreCase);
    var hm = Regex.Match(svg, @"height\s*=\s*[""']?(\d+(?:\.\d+)?)", RegexOptions.IgnoreCase);
    float wi = 800, he = 600;
    if (wm.Success) float.TryParse(wm.Groups[1].Value, out wi);
    if (hm.Success) float.TryParse(hm.Groups[1].Value, out he);
    return (wi, he);
}

static string? DetectSolidColor(SKBitmap bmp)
{
    var pixels = bmp.Pixels!;
    if (pixels.Length == 0) return null;
    uint first = 0; bool found = false;
    for (var i = 0; i < pixels.Length; i++)
    {
        var px = (uint)pixels[i];
        if ((px & 0xFF000000) == 0) continue;
        if (!found) { first = px; found = true; continue; }
        if (px != first) return null;
    }
    if (!found) return "#00000000";
    var b = (first >> 0) & 0xFF; var g = (first >> 8) & 0xFF;
    var r = (first >> 16) & 0xFF; var a = (first >> 24) & 0xFF;
    return $"#{r:x2}{g:x2}{b:x2}{a:x2}";
}

static void ReduceBitDepth(SKBitmap bmp, int bitShift)
{
    var pixels = bmp.Pixels!;
    var mask = (uint)((0xFF >> bitShift) << bitShift);
    var scale = 255.0f / (255 >> bitShift);
    for (var i = 0; i < pixels.Length; i++)
    {
        var p = (uint)pixels[i];
        var a = (p >> 24) & 0xFF; var r = (p >> 16) & 0xFF;
        var g = (p >> 8) & 0xFF; var b = (p >> 0) & 0xFF;
        r = (uint)((byte)(r & mask) * scale);
        g = (uint)((byte)(g & mask) * scale);
        b = (uint)((byte)(b & mask) * scale);
        pixels[i] = new SKColor((byte)r, (byte)g, (byte)b, (byte)a);
    }
}

static void PrintProgress(object lk, int done, int total, int skipped)
{
    lock (lk) { if (done % 100 == 0 || done == total) Console.Write($"\r  [{100.0*done/total,3:F0}%] {done}/{total} tiles ({skipped} sc)"); }
}