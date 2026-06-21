using System.Collections.Concurrent;
using System.CommandLine;
using System.Text.Json;
using System.Text.RegularExpressions;
using Svg.Skia;
using SkiaSharp;

// ─────────────────────────────────────────────────────────────────────
//  SVG Tile Pre-Renderer (C# / SkiaSharp / Multi-Threaded)
//
//  Designed as a drop-in replacement for cli/pre-render.mjs.
//
//  Outputs the exact same directory layout & manifest.json schema
//  so the client-side JS library needs zero changes.
//
//  Performance advantages over the Node.js version:
//    • SkiaSharp native rasterization (no subprocess / WASM bridge)
//    • Parallel.ForEach on tiles within a level
//    • Lock-free per-level full-image render (one per level)
//    • Cascading delegation – if a parent is skipped all children
//      are skipped automatically without extraction or comparison
//
//  Usage:
//    dotnet run --project cli/PreRender -- Altis_Map.svg \
//      --tileSize 256 --numLevels 6 --lowestRes 4096 --highestRes 40960
// ─────────────────────────────────────────────────────────────────────

// ── Argument definition ────────────────────────────────────────────
var svgFileArg = new Argument<FileInfo>(
    name: "svgFile",
    description: "Path to the SVG file to rasterize."
);

var tileSizeOpt = new Option<int>(
    aliases: ["--tileSize"],
    description: "Tile dimensions in pixels",
    getDefaultValue: () => 256
);

var numLevelsOpt = new Option<int?>(
    aliases: ["--numLevels"],
    description: "Exact number of pyramid levels"
);

var lowestResOpt = new Option<int?>(
    aliases: ["--lowestRes"],
    description: "Full-SVG pixel width at coarsest level"
);

var highestResOpt = new Option<int?>(
    aliases: ["--highestRes"],
    description: "Full-SVG pixel width at finest level"
);

var outDirOpt = new Option<DirectoryInfo>(
    aliases: ["--outDir"],
    description: "Output base directory",
    getDefaultValue: () => new DirectoryInfo("./rasterizationData")
);

var maxCanvasDimOpt = new Option<int>(
    aliases: ["--maxCanvasDim"],
    description: "Canvas cap for auto level calculation",
    getDefaultValue: () => 4096
);

var threadsOpt = new Option<int>(
    aliases: ["--threads", "-t"],
    description: "Number of parallel threads (0 = auto)",
    getDefaultValue: () => Environment.ProcessorCount
);

var rootCommand = new RootCommand("SVG tile pre-renderer (C# / SkiaSharp)")
{
    svgFileArg, tileSizeOpt, numLevelsOpt, lowestResOpt,
    highestResOpt, outDirOpt, maxCanvasDimOpt, threadsOpt
};

rootCommand.SetHandler(
    async (FileInfo svgFile, int tileSize, int? numLevels, int? lowestRes,
            int? highestRes, DirectoryInfo outDir, int maxCanvasDim, int threads) =>
    {
        await PreRender(svgFile, tileSize, numLevels, lowestRes,
                        highestRes, outDir, maxCanvasDim, threads);
    },
    svgFileArg, tileSizeOpt, numLevelsOpt, lowestResOpt,
    highestResOpt, outDirOpt, maxCanvasDimOpt, threadsOpt
);

return await rootCommand.InvokeAsync(args);

// ─────────────────────────────────────────────────────────────────────
//  Main logic
// ─────────────────────────────────────────────────────────────────────

static async Task<int> PreRender(
    FileInfo svgFile, int tileSize, int? numLevels, int? lowestRes,
    int? highestRes, DirectoryInfo outDir, int maxCanvasDim, int threads)
{
    if (!svgFile.Exists)
    {
        Console.Error.WriteLine($"SVG file not found: {svgFile.FullName}");
        return 1;
    }

    // ── Read & parse SVG dimensions ──────────────────────────────────
    var svgText = File.ReadAllText(svgFile.FullName);
    var (svgWidth, svgHeight) = ParseSvgDimensions(svgText);
    var svgName = Path.GetFileNameWithoutExtension(svgFile.Name);

    // ── Compute tile pyramid (identical to TilePyramid.js) ───────────
    var minLevel = 0;
    if (lowestRes.HasValue)
        minLevel = Math.Max(0, (int)Math.Ceiling(Math.Log2((double)lowestRes.Value / tileSize)));

    int maxLevel;
    if (numLevels.HasValue)
        maxLevel = minLevel + Math.Max(1, numLevels.Value) - 1;
    else if (highestRes.HasValue)
    {
        var baseRes = tileSize * Math.Pow(2, minLevel);
        if (highestRes.Value <= baseRes)
            maxLevel = minLevel;
        else
            maxLevel = minLevel + (int)Math.Ceiling(Math.Log2(highestRes.Value / baseRes));
    }
    else
    {
        var lvl = minLevel;
        while (tileSize * Math.Pow(2, lvl) < maxCanvasDim &&
               tileSize * Math.Pow(2, lvl) < Math.Max(svgWidth, svgHeight) * 0.5)
            lvl++;
        maxLevel = lvl;
    }

    var totalTiles = 0;
    for (var lvl = minLevel; lvl <= maxLevel; lvl++)
    {
        var cols = (int)Math.Pow(2, lvl);
        totalTiles += cols * cols;
    }

    // ── Output directories ───────────────────────────────────────────
    var svgOutDir = Path.Combine(outDir.FullName, svgName);
    var tilesDir = Path.Combine(svgOutDir, "tiles");
    Directory.CreateDirectory(tilesDir);

    // ── Load SVG document (Svg.Skia) ─────────────────────────────────
    using var svg = new SKSvg();
    var picture = svg.Load(svgFile.FullName);
    if (picture is null)
    {
        Console.Error.WriteLine("Failed to load SVG (null picture).");
        return 1;
    }

    Console.WriteLine($"SVG: {svgWidth}×{svgHeight}, pyramid: levels {minLevel}–{maxLevel} ({maxLevel - minLevel + 1} levels, {totalTiles} tiles)");
    Console.WriteLine($"Output: {svgOutDir}");
    Console.WriteLine($"Threads: {(threads > 0 ? threads : Environment.ProcessorCount)}");
    Console.WriteLine($"Strategy: 1 SVG render per level, parallel tile extraction, cascade delegation\n");

    // ── Delegation tracking (thread-safe) ────────────────────────────
    var delegations = new ConcurrentDictionary<string, (int Level, int Col, int Row)>();
    var delegatedSet = new ConcurrentDictionary<string, bool>();

    var renderedCount = new ConcurrentDictionary<int, int>();
    var skippedCount = new ConcurrentDictionary<int, int>();

    // Configure parallelism
    var parallelOptions = new ParallelOptions
    {
        MaxDegreeOfParallelism = threads > 0 ? threads : Environment.ProcessorCount
    };

    // ── Rasterize level by level ─────────────────────────────────────
    // For high levels the full bitmap can be too large (L9 = 131072² = 64 GB).
    // We render in STRIPS whose memory ≤ maxStripMemory (256 MB).
    // Strip dimensions are dynamically computed per level.
    const long maxStripMemory = 256L * 1024 * 1024; // 256 MB per strip

    for (var level = minLevel; level <= maxLevel; level++)
    {
        var cols = (int)Math.Pow(2, level);
        var rows = cols;
        var totalThisLevel = cols * rows;

        Console.WriteLine($"\n── Level {level}: {cols}×{rows} = {totalThisLevel} tiles ──");

        var fullW = tileSize * cols;
        var scale = (float)fullW / svgWidth;
        var fullH = (int)(scale * svgHeight);

        // Dynamically compute max tile rows per strip so the strip
        // bitmap stays under maxStripMemory.
        var bytesPerPixelRow = (long)fullW * 4;
        var maxStripPixelH = (int)(maxStripMemory / bytesPerPixelRow);
        if (maxStripPixelH < tileSize) maxStripPixelH = tileSize;
        var maxTilesPerStrip = maxStripPixelH / tileSize;
        if (maxTilesPerStrip < 1) maxTilesPerStrip = 1;

        var stripCount = (int)Math.Ceiling((double)rows / maxTilesPerStrip);
        var actualStripPixelH = maxTilesPerStrip * tileSize;
        var stripMemMb = (fullW * actualStripPixelH * 4L) / (1024 * 1024);

        Console.WriteLine($"  Rasterizing level {level}: {fullW}×{fullH}px (strips: {maxTilesPerStrip} tile rows, ~{stripMemMb} MB each, {stripCount} strips)");

        var tilesProcessed = 0;
        var levelRendered = 0;
        var levelSkipped = 0;
        var lockObj = new object();

        for (var stripIdx = 0; stripIdx < stripCount; stripIdx++)
        {
            var stripStartRow = stripIdx * maxTilesPerStrip;
            var stripEndRow = Math.Min(stripStartRow + maxTilesPerStrip, rows);
            var stripTileRows = stripEndRow - stripStartRow;
            var stripPixelY = stripStartRow * tileSize;
            var stripPixelH = stripTileRows * tileSize;

            // Render just this strip of the SVG
            using var stripBitmap = new SKBitmap(fullW, stripPixelH);
            using var stripCanvas = new SKCanvas(stripBitmap);
            stripCanvas.Clear(SKColors.Transparent);

            stripCanvas.Scale(scale, scale);
            stripCanvas.Translate(0, -(float)stripPixelY / scale);
            stripCanvas.DrawPicture(picture);
            stripCanvas.Flush();

            // Build tile list for this strip, filtering cascade-delegated
            var stripTileList = new List<(int Col, int Row)>();
            for (var row = stripStartRow; row < stripEndRow; row++)
            for (var col = 0; col < cols; col++)
            {
                if (level > minLevel)
                {
                    var parentKey = $"L{level - 1}-R{row / 2}-C{col / 2}";
                    if (delegatedSet.ContainsKey(parentKey))
                    {
                        var grandparent = delegations[parentKey];
                        delegations[$"L{level}-R{row}-C{col}"] = grandparent;
                        delegatedSet[$"L{level}-R{row}-C{col}"] = true;
                        Interlocked.Increment(ref levelSkipped);
                        tilesProcessed++;
                        continue;
                    }
                }
                stripTileList.Add((col, row));
            }

            // ── Process strip tiles in parallel ──────────────────
            Parallel.ForEach(stripTileList, parallelOptions, (tile) =>
            {
                var (col, row) = tile;
                var key = $"L{level}-R{row}-C{col}";
                var outFile = Path.Combine(tilesDir, $"{key}.png");
                var localTileX = col * tileSize;
                var localTileY = (row - stripStartRow) * tileSize;

                using var tileBmp = new SKBitmap(tileSize, tileSize);
                lock (stripBitmap)
                {
                    if (!stripBitmap.ExtractSubset(tileBmp,
                        new SKRectI(localTileX, localTileY,
                            localTileX + tileSize, localTileY + tileSize)))
                    {
                        Console.Error.WriteLine($"  FAILED to extract {key}");
                        return;
                    }
                }

                // ── Smart comparison ──────────────────────────────
                if (level > minLevel)
                {
                    var parentLevel = level - 1;
                    var parentCol = col / 2;
                    var parentRow = row / 2;
                    var parentKey = $"L{parentLevel}-R{parentRow}-C{parentCol}";

                    if (!delegatedSet.ContainsKey(parentKey))
                    {
                        var parentFile = Path.Combine(tilesDir, $"{parentKey}.png");
                        if (File.Exists(parentFile))
                        {
                            using var parentBitmap = SKBitmap.Decode(parentFile);
                            if (parentBitmap is not null)
                            {
                                var half = tileSize / 2;
                                var quadrantCol = col % 2;
                                var quadrantRow = row % 2;

                                using var upscaledQuadrant = new SKBitmap(tileSize, tileSize);
                                using var upscaledCanvas = new SKCanvas(upscaledQuadrant);
                                upscaledCanvas.Clear(SKColors.Transparent);
                                var srcRect = new SKRect(
                                    quadrantCol * half, quadrantRow * half,
                                    quadrantCol * half + half, quadrantRow * half + half);
                                var dstRect = new SKRect(0, 0, tileSize, tileSize);
                                upscaledCanvas.DrawBitmap(parentBitmap, srcRect, dstRect);
                                upscaledCanvas.Flush();

                                if (BitmapsAreIdentical(tileBmp, upscaledQuadrant))
                                {
                                    delegations[key] = (parentLevel, parentCol, parentRow);
                                    delegatedSet[key] = true;
                                    Interlocked.Increment(ref levelSkipped);
                                    Interlocked.Increment(ref tilesProcessed);
                                    PrintProgress(lockObj, tilesProcessed, totalThisLevel, levelSkipped);
                                    return;
                                }
                            }
                        }
                    }
                }

                // ── Save tile PNG ─────────────────────────────────
                using var pngData = tileBmp.Encode(SKEncodedImageFormat.Png, 100);
                using var fs = File.Create(outFile);
                pngData.SaveTo(fs);

                Interlocked.Increment(ref levelRendered);
                Interlocked.Increment(ref tilesProcessed);
                PrintProgress(lockObj, tilesProcessed, totalThisLevel, levelSkipped);
            });
        }

        renderedCount[level] = levelRendered;
        skippedCount[level] = levelSkipped;
        Console.WriteLine($"\n  Level {level} done: {levelRendered} rendered, {levelSkipped} skipped ({(totalThisLevel > 0 ? (levelSkipped * 100.0 / totalThisLevel) : 0):F1}% of level)");
    }

    // ── Write manifest.json ──────────────────────────────────────────
    var actualTileCount = renderedCount.Values.Sum();
    var totalDelegated = skippedCount.Values.Sum();

    // Convert delegations dictionary to JSON-friendly format
    var delegationDict = new Dictionary<string, object>();
    foreach (var kvp in delegations)
    {
        delegationDict[kvp.Key] = new { level = kvp.Value.Level, col = kvp.Value.Col, row = kvp.Value.Row };
    }

    var levels = new List<object>();
    for (var lvl = minLevel; lvl <= maxLevel; lvl++)
    {
        levels.Add(new { level = lvl, cols = (int)Math.Pow(2, lvl), rows = (int)Math.Pow(2, lvl) });
    }

    var manifest = new
    {
        svgName,
        svgWidth,
        svgHeight,
        tileSize,
        minLevel,
        maxLevel,
        numLevels = maxLevel - minLevel + 1,
        totalTiles,
        actualTileCount,
        delegationCount = totalDelegated,
        tileFormat = "png",
        levels,
        delegations = delegationDict
    };

    var manifestPath = Path.Combine(svgOutDir, "manifest.json");
    var jsonOptions = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, jsonOptions));

    var savingsPct = totalTiles > 0 ? (totalDelegated * 100.0 / totalTiles) : 0;
    Console.WriteLine($"\nDone! {actualTileCount} PNGs saved, {totalDelegated} tiles delegated ({savingsPct:F1}% savings).");

    // Per-level bar chart
    for (var lvl = minLevel + 1; lvl <= maxLevel; lvl++)
    {
        var totalAtLevel = (int)Math.Pow(2, lvl) * (int)Math.Pow(2, lvl);
        var delegatedAtLevel = skippedCount.GetValueOrDefault(lvl, 0);
        var pct = totalAtLevel > 0 ? (delegatedAtLevel * 100.0 / totalAtLevel) : 0;
        var bar = new string('█', Math.Max(0, (int)Math.Round(pct / 100.0 * 30)));
        var empty = new string('░', 30 - bar.Length);
        Console.WriteLine($"    Level {lvl} = {totalAtLevel} tiles: {bar}{empty} {delegatedAtLevel}/{totalAtLevel} delegated ({pct:F1}%)");
    }

    return 0;
}

// ── Helpers ─────────────────────────────────────────────────────────

static (float Width, float Height) ParseSvgDimensions(string svgText)
{
    // Extract viewBox
    var vbMatch = Regex.Match(
        svgText, @"viewBox\s*=\s*[""']([^""']+)[""']",
        RegexOptions.IgnoreCase);

    if (vbMatch.Success)
    {
        var parts = vbMatch.Groups[1].Value.Trim().Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 4 && float.TryParse(parts[2], out var w) && float.TryParse(parts[3], out var h))
            return (w, h);
    }

    var wm = Regex.Match(
        svgText, @"width\s*=\s*[""']?(\d+(?:\.\d+)?)",
        RegexOptions.IgnoreCase);
    var hm = Regex.Match(
        svgText, @"height\s*=\s*[""']?(\d+(?:\.\d+)?)",
        RegexOptions.IgnoreCase);

    var width = 800f;
    var height = 600f;
    if (wm.Success) float.TryParse(wm.Groups[1].Value, out width);
    if (hm.Success) float.TryParse(hm.Groups[1].Value, out height);
    return (width, height);
}

static bool BitmapsAreIdentical(SKBitmap a, SKBitmap b)
{
    if (a.Width != b.Width || a.Height != b.Height) return false;

    var aPixels = a.Pixels!;
    var bPixels = b.Pixels!;
    var length = aPixels.Length;

    if (length != bPixels.Length) return false;

    var maxDiffs = (int)(length * 0.001); // 0.1% tolerance
    var diffCount = 0;

    for (var i = 0; i < length; i++)
    {
        if (aPixels[i] != bPixels[i])
        {
            diffCount++;
            if (diffCount > maxDiffs) return false;
        }
    }
    return true;
}

static void PrintProgress(object lockObj, int done, int total, int skipped)
{
    lock (lockObj)
    {
        if (done % 100 == 0 || done == total)
        {
            var pct = total > 0 ? Math.Round(done * 100.0 / total) : 0;
            Console.Write($"\r  [{pct,3:F0}%] {done}/{total} tiles ({skipped} skipped)");
        }
    }
}