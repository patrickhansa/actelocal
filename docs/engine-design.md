# Compression engine: design

Status: **implemented** (spec step 2, plus the photo-page part of step 3). Code: `src/engine/`.

## 1. Summary

The engine turns a list of pages into one PDF no larger than a target size, at the best readability that fits. Each page is drawn into a canvas (a pixel buffer), saved as a JPEG, and the JPEGs are packed into a new PDF. The engine chooses one resolution and one JPEG quality for the whole document by measuring real JPEG sizes, never by guessing. It runs entirely in the browser and keeps at most two rendered pages in memory.

## 2. Pipeline

```
 Compress PDF:   PDF file ──► PdfSource ───┐
                                           ├──► PageSource[] ──► search ──► JPEG per page ──► assemble ──► output PDF
 Photos to PDF:  photos ────► PhotoSource ─┘                     (render + encode)            (pdf-lib)
```

The two tools differ only in where their pages come from. Everything after `PageSource[]` is shared.

## 3. Page sources

The engine's one abstraction is a page that knows its size and can draw itself. In C++ terms it's an abstract base class with one virtual method:

```ts
interface PageSource {
  readonly widthPt: number;   // output page size in PDF points (1 pt = 1/72 inch)
  readonly heightPt: number;
  /** Draw the page onto a canvas that is already filled white, at pxPerPt pixels per point. */
  draw(ctx: CanvasRenderingContext2D, pxPerPt: number): Promise<void>;
}
```

### PdfSource (Compress PDF), `pdf-source.ts`

- Opens the file with pdf.js from its bytes in memory, never from a URL. One pdf.js worker is reused for the whole visit, so later files skip its startup. `warmUpPdf()` starts it ahead of time.
- Makes one `PageSource` per input page. The page size includes the page's crop box and rotation, so the output looks the way the input does in a PDF viewer.
- Draws the page the way pdf.js prints it (`intent: 'print'`). Typed-in values in PDF forms and stamps then end up in the image. pdf.js's screen mode puts form fields in a separate HTML layer, so the values would silently vanish.
- Error mapping: pdf.js `PasswordException` → `password-protected`; anything else that stops the file from opening → `invalid-pdf`.
- Releases each page's decoded images right after drawing it.

### PhotoSource (Photos to PDF), `photo-source.ts`

Input: the photos in the user's order, each with a rotation of 0, 90, 180 or 270°.

| Layout | Page | Placement |
|---|---|---|
| One per page | A4 (595 × 842 pt), in the orientation of the rotated photo | Photo scaled to fit inside 10 mm margins, centred, aspect ratio kept |
| Two per page (ID card front and back) | A4 portrait | Photos 1+2 on page 1, 3+4 on page 2, and so on. Each photo fits in its half of the page, with 10 mm margins and a 10 mm gap. An odd last photo goes in the top half |

- The browser applies the photo's EXIF orientation when decoding it, and the user's rotation is added on top.
- Each photo is decoded only when its page is drawn, at the pixel size it's drawn at, and freed straight after. Decoding straight to the smaller size is faster, and a 12 MP photo never sits in memory at full size (about 48 MB).
- If decoding fails, the engine throws `unsupported-image` with the file name. HEIC on non-Apple browsers fails this way until stretch goal 1 adds HEIC support.
- GPS and other EXIF data disappear automatically, because the output contains only new JPEGs made from canvas pixels.

## 4. Render and encode, `raster.ts`

**Two canvases are used in turn**, so page *n+1* is drawn into one while page *n* is still encoding from the other. For each page:

1. Resize the canvas to the page size at the chosen resolution.
2. Fill it white. A canvas starts transparent, and the JPEG encoder turns transparent pixels black.
3. `source.draw(ctx, pxPerPt)`.
4. If grayscale is on, fill the whole canvas with gray using the `color` blend mode. That keeps each pixel's brightness and takes away its colour in one draw call, which runs on the GPU in all browsers. It replaces the per-pixel loop from the first draft.
5. Encode the JPEGs with `canvas.toBlob('image/jpeg', quality)`. The browser copies the canvas when the call is made and encodes on another thread. All qualities still needed for a page are encoded at once, up to 20 million pixels in flight (`MAX_PARALLEL_ENCODE_PIXELS`), which caps the extra memory at about 80 MB on phones. A `null` result means the browser couldn't allocate memory, and becomes `render-failed`.

When the job ends, both canvases are resized to 0 × 0. Otherwise iOS Safari keeps their memory until the page is closed.

## 5. Choosing resolution and quality, `search.ts`

### The settings (all in `config.ts`)

- **Resolution levels:** 300, 250, 200, 175, 150, 125 and 100 dpi. Pages larger than A4 are rendered with the pixel count an A4 page would get at that dpi. That keeps the longest side at 3508 px or less, under iOS Safari's canvas limit. It also handles PDFs with absurd page sizes: tools that convert photos at 1 px = 1 pt produce "pages" over a metre tall.
- **JPEG quality:** 0.55, 0.65, 0.75 and 0.85. At the lowest level (100 dpi) only, 0.35 and 0.45 are also allowed as a last resort.
- **Grayscale:** the user's choice. The engine never turns it on by itself.

**The goal:** the highest resolution at which some allowed quality fits, then the highest quality that fits there. For text, pixels matter more than JPEG quality. Below about 0.55, though, the smudges JPEG leaves around letters hurt more than one resolution step does.

### Measuring a resolution

`tryResolution` renders every page once and encodes it at every quality still in the running. When a quality's running total goes over the budget, it drops out, along with every higher quality, since a higher quality is never smaller. One pass gives the exact total for every quality at that level. That's why there's no binary search on quality: a binary search would need every page encoded again for each probe, which means either keeping every rendered page in memory (about 350 MB for 10 pages at 300 dpi) or rendering everything again.

Each attempt at a resolution ends in one of three ways:

- **fits:** at least one quality fits for all pages, and its assembled PDF really is under the target.
- **failed:** the lowest quality went over the budget. This is measured, so the level certainly doesn't fit.
- **abandoned:** the pages so far *project* the lowest quality above 1.1 × the budget, so the attempt stops early. On the first page only the lowest quality is encoded, so a hopeless level costs one render and one encode. An abandoned level counts as skipped, not failed.

### The search

```
budget = target − pdfOverhead(pageCount)

1. Descend
   level = 300 dpi
   loop:
       outcome = tryResolution(level)                 (may abandon, except at the last level)
       if fits: stop
       if failed at the last level: throw target-unreachable (estimated smallest size)
       level = highest lower level whose predicted size fits
               (bytes measured so far, extrapolated to all pages, scaled by pixel count),
               or the last level if none is predicted to fit

2. Climb
   for each level just above the one that fits, while it was skipped (never settled):
       optimistic estimate = lowest-quality bytes there × (pixel ratio)^0.75
       if estimate > budget: stop
       outcome = tryResolution(that level)             (never abandons)
       if it fits: it becomes the result, keep climbing; otherwise stop

return the highest level that fit, at its highest fitting quality
```

**Why both steps.** Descending with jumps is fast, but a jump can skip a level that fits, for example when the first pages are dense and the rest are blank. Climbing fixes that with complete measurements from the level that fit. Going up, JPEG bytes grow a little slower than pixel count: measured scans give an exponent of about 0.92. Using 0.75 makes the estimate optimistic, so a level that might fit gets tried rather than ruled out.

**Properties:**

- **Never over the target:** every size is measured, and the finished PDF is checked before it's returned. If the PDF overhead estimate turns out too low, the next lower quality is used. Its JPEGs are still in memory.
- **Finds the best setting:** unit tests compare the search with brute force for four document shapes and about 60 targets each.
- **Bounded memory:** two canvases, the encodes in flight, and the JPEGs of qualities still in the running. A quality's JPEGs are dropped as soon as it goes over the budget.

### Measured speed

Desktop (Ryzen 7, headless Chrome), with a synthetic 10-page scan of 15.5 MB:

| Target | Result | Time | Pages rendered |
|---|---|---|---|
| 1 MB | 883 KB at 100 dpi, q 0.35 | 1.2 s | 12 |
| 2 MB | 1999 KB at 125 dpi, q 0.75 | 2.1–2.3 s | 22 |
| 5 MB | 4881 KB at 250 dpi, q 0.65 | 4.8 s | 20 |

A plain walk from 300 dpi downwards took 5–7 s for the same jobs. Phones are expected to be 3–5× slower. The worst cases are near misses, where a level fails only on the last page, because those have to be measured to the end. The 1 MB output above is still readable at 100% zoom, small print included.

## 6. Building the PDF, `assemble.ts`

- pdf-lib creates a new document. For each page it embeds the JPEG bytes unchanged (as a `DCTDecode` image, with no second compression), adds a page of the source's size, and draws the image across the whole page.
- Because the document is new, no metadata from the input carries over (author, software, XMP). Producer and Creator are set to "ActeLocal".
- Saved with object streams, which keeps the PDF structure compact.
- `pdfOverhead(n) = 1,000 + 400 × n` bytes. pdf-lib actually adds about 540 + 345 × n, and a unit test checks the bound.
- **Units:** 1 KB = 1,000 bytes and 1 MB = 1,000,000 bytes. A portal's "1 MB" may mean 1,000,000 or 1,048,576 bytes, and the smaller of the two passes under either meaning.

## 7. Public API, `index.ts`

```ts
compressPdf(file: File, options: EngineOptions): Promise<EngineResult>
photosToPdf(photos: PhotoInput[], options: EngineOptions & { layout: 'one-per-page' | 'two-per-page' }): Promise<EngineResult>
warmUpPdf(): Promise<void>   // load pdf.js and start its worker in the background

interface PhotoInput { file: File; rotation: 0 | 90 | 180 | 270 }

interface EngineOptions {
  targetBytes: number;                      // e.g. 1_000_000
  grayscale: boolean;
  onProgress?: (p: Progress) => void;       // before each page: { dpi, attempt, page, pageCount }
  onAttempt?: (a: AttemptLog) => void;      // after each resolution attempt (dev harness)
  signal?: AbortSignal;                     // cancellation, checked between pages
}

interface EngineResult {
  pdf: Uint8Array;                          // the finished file
  pageCount: number;
  dpi: number;                              // chosen level (0 if unchanged)
  quality: number;                          // chosen JPEG quality (0 if unchanged)
  preview: Blob | null;                     // page 1 as JPEG, for the readability check
  firstPageSize: { widthPt; heightPt };     // to show the preview as large as a viewer at 100% would
  unchanged: boolean;                       // the input already fit and grayscale was off
}
```

pdf.js is loaded only when a PDF is opened, so the photo tool never downloads it.

**Errors.** The engine throws `EngineError` with a `code`, and the UI maps each code to a Romanian message. The engine itself contains no user-facing text.

| Code | When | Detail |
|---|---|---|
| `invalid-pdf` | Not a PDF, or damaged | |
| `password-protected` | The PDF needs a password to open | |
| `unsupported-image` | The browser can't decode a photo | file name |
| `no-pages` | Empty PDF, or no photos | |
| `target-unreachable` | Doesn't fit even at 100 dpi and quality 0.35 | estimated smallest size, so the UI can suggest a limit that works |
| `render-failed` | The browser couldn't allocate or encode a canvas (out of memory) | |
| `cancelled` | The user cancelled | |

## 8. Files and dependencies

```
src/engine/
  config.ts           every tunable number
  types.ts            PageSource, EngineOptions, EngineResult, EngineError
  pdf-source.ts       PDF file → PageSource[]          (the only file that imports pdf.js)
  photo-source.ts     photos → PageSource[], A4 layouts
  raster.ts           two canvases, grayscale, parallel JPEG encoding
  search.ts           §5; render and encode are passed in, so it runs without a browser
  assemble.ts         JPEGs → PDF                       (the only file that imports pdf-lib)
  index.ts            public API
  *.test.ts           unit tests (Vitest)
dev/engine.html       harness: run the engine on any file, see every attempt (dev server only)
dev/sample.ts         generates a synthetic scanned document for benchmarks
scripts/bench.mjs     drives headless Chrome to benchmark, snapshot results and check the CSP
```

**pdf.js (`pdfjs-dist` 6.5, Apache-2.0)**

- Parsing and image decoding run in pdf.js's own worker. Its script is bundled and served from our site, which `worker-src 'self'` allows.
- At runtime pdf.js loads small WebAssembly decoders for three things:
  - JBIG2 images, which are common in black-and-white scans
  - JPEG 2000 images
  - colour profiles

  `vite.config.ts` serves them at `/pdfjs/wasm/` in dev and copies them there in the build, with their licences. They take about 420 KB and load only when a file needs them.
- The CSP allows this with `script-src 'self' 'wasm-unsafe-eval'`. That directive allows compiling WebAssembly only, not JavaScript `eval`.
- Font data and CMaps aren't shipped. They're only needed for PDFs with non-embedded fonts or Asian text, and pdf.js falls back to system fonts without them.

**pdf-lib 1.17.1 (MIT).** Its last release was in 2022, but we use only a small, stable part. `@cantoo/pdf-lib` is a maintained fork with the same API, and only `assemble.ts` would change if we ever needed it.

## 9. Testing

```sh
npm test                                            # unit tests, no browser needed
npm run dev                                         # then open /dev/engine.html
node scripts/bench.mjs sample 10 4                  # make test-files/synthetic-scan-10p.pdf
node scripts/bench.mjs run <file in test-files> 1000 2000
node scripts/bench.mjs snapshot <file> 1000         # writes the result and each page as PNG
PROD=1 node scripts/bench.mjs csp                   # production build + headers: decoders load, uploads blocked
```

1. **Unit tests** (22):
   - the search against brute force, and how many pages it renders
   - abandoned and failed levels, cancellation, PDF overhead overshoot
   - the photo layout maths
   - pdf-lib's real overhead against `pdfOverhead()`
2. **Dev harness**, `/dev/engine.html`. Pick a file and a target to see each attempt (dpi, pages, qualities that fit, time), the result, page 1 at 100% zoom and a download link. To try it on a phone on the same Wi-Fi, start the dev server with `npm run dev -- --host`.
3. **Benchmark script:** headless Chrome over the DevTools protocol, with no extra dependencies.
   - Times jobs and counts main-thread stalls over 50 ms.
   - Renders results back to PNG for checking by eye.
   - With `PROD=1`, runs against a production build served with the real headers. It checks that pdf.js's decoders compile under the CSP and that a request to another origin is blocked by `connect-src`.

**Still to do:**

- Run the spec's acceptance check on real scans: 8–20 MB, about 10 pages, under 1 MB and readable at 100%.
- Time it on a phone.
- Test a PDF with JBIG2 or JPEG 2000 images. The synthetic scan uses plain JPEG, so it doesn't exercise the decoders.

## Appendix: TypeScript for C++ readers

| TypeScript | Closest C++ idea |
|---|---|
| `interface PageSource { … }` | An abstract class with pure virtual members. Any object with matching members qualifies, with no inheritance needed |
| `async function f(): Promise<T>` / `await` | A coroutine returning a future / `co_await`. JavaScript is single-threaded: `await` yields to the event loop, so there are no data races |
| `Promise.all([a, b])` | Waiting on several futures at once |
| `Uint8Array` | `std::vector<uint8_t>` / `std::span<uint8_t>` |
| `Blob` | An immutable byte buffer owned by the browser, possibly stored outside the JS heap |
| `Map<K, V>` | `std::map`, but iterating in insertion order |
| `'one-per-page' \| 'two-per-page'` | `enum class`, written as string values |
| `{ kind: 'fits'; … } \| { kind: 'failed'; … }` | `std::variant` with the alternative named by `kind` |
| `AbortSignal` | `std::stop_token` |
| `throw new EngineError('invalid-pdf')` | Throwing a typed exception |
| canvas | An RGBA framebuffer the browser can draw into and encode as JPEG |
