# Compression engine: design

Status: **implemented** (spec step 2, plus the photo-page part of step 3). Code: `src/engine/`.

## 1. Summary

The engine turns a list of pages into one PDF no larger than a target size, at the best readability that fits. Each page is drawn into a canvas (a pixel buffer), saved as a JPEG, and the JPEGs are packed into a new PDF. The engine chooses one resolution and one JPEG quality for the whole document by measuring real JPEG sizes, never by guessing. It runs entirely in the browser and keeps at most two rendered pages in memory. JPEG encoding runs in Web Workers, so the page stays responsive.

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

## 4. Render and encode, `raster.ts` and `encoder.ts`

One canvas is reused for every page:

1. Resize the canvas to the page size at the chosen resolution.
2. Fill it white. A canvas starts transparent, and the JPEG encoder turns transparent pixels black.
3. `source.draw(ctx, pxPerPt)`.
4. If grayscale is on, fill the whole canvas with gray using the `color` blend mode. That keeps each pixel's brightness and takes away its colour in one draw call, which runs on the GPU in all browsers. It replaces the per-pixel loop from the first draft.
5. Take a snapshot of the canvas with `createImageBitmap`, which is fast and asynchronous. The canvas is then free for the next page while this one encodes.

**JPEG encoding runs in Web Workers** (`encode-worker.ts`).

- **Why:** profiling showed that Chrome's `canvas.toBlob` does much of its work on the main thread, up to half of a job's main-thread time, and freezes the page for up to 450 ms at a time.
- **How:** each worker draws a copy of the snapshot onto an `OffscreenCanvas` and calls `convertToBlob`. A pool of up to 4 workers is created once per visit. The qualities a page needs are split across the workers, each with its own copy of the snapshot. Copies in flight are capped at 20 million pixels (`MAX_PARALLEL_ENCODE_PIXELS`), about 80 MB.
- **Fallback:** without `OffscreenCanvas` (iOS before 16.4), or if a worker fails, encoding falls back to `toBlob` on the main thread.
- **Diagnostics:** `encoderInfo()` reports which encoder is active.

When the job ends, the canvas is resized to 0 × 0. Otherwise iOS Safari keeps its memory until the page is closed.

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

Desktop (Ryzen 7 with Radeon 780M, headless Chrome with GPU). "Freezes" counts main-thread tasks over 50 ms:

| Input | Target | Result | Time | Freezes |
|---|---|---|---|---|
| Synthetic scan, 10 pages, 15.5 MB | 1 MB | 883 KB at 100 dpi, q 0.35 | 1.2–1.4 s | 0 |
| same | 2 MB | 1999 KB at 125 dpi, q 0.75 | 2.3 s | 0 |
| same | 5 MB | 4881 KB at 250 dpi, q 0.65 | 3.4 s | 0 |
| 6 real phone photos, 50 MB, one per page | 2 MB | 1907 KB at 175 dpi | 2.1–2.5 s | 3–7, ≤ 125 ms |
| 2 real phone photos, two per page | 500 KB | 491 KB at 250 dpi | 1.0 s | 0–1 |
| Real phone-app scan, 1 page | 100 KB | 96 KB at 150 dpi | 0.4 s | 0 |

The same scan jobs took 5–7 s before the search learned to jump and abandon, and froze the page for up to 450 ms before encoding moved to workers. Phones are expected to be 3–5× slower. The worst cases are near misses, where a level fails only on the last page, because those have to be measured to the end. The 1 MB output above is still readable at 100% zoom, small print included.

## 6. Building the PDF, `assemble.ts`

- pdf-lib creates a new document. For each page it embeds the JPEG bytes unchanged (as a `DCTDecode` image, with no second compression), adds a page of the source's size, and draws the image across the whole page.
- Because the document is new, no metadata from the input carries over (author, software, XMP). Producer and Creator are set to "ActeLocal".
- Saved with object streams, which keeps the PDF structure compact.
- `pdfOverhead(n) = 1,000 + 400 × n` bytes. pdf-lib actually adds about 540 + 345 × n, and a unit test checks the bound.
- **Units:** 1 KB = 1,000 bytes and 1 MB = 1,000,000 bytes. A portal's "1 MB" may mean 1,000,000 or 1,048,576 bytes, and the smaller of the two passes under either meaning.

## 7. Public API, `index.ts`

```ts
inspectPdf(file: File): Promise<PdfInfo>   // call on file selection, to warn before compressing (§10)
compressPdf(file: File, options: EngineOptions): Promise<EngineResult>
photosToPdf(photos: PhotoInput[], options: EngineOptions & { layout: 'one-per-page' | 'two-per-page' }): Promise<EngineResult>
warmUp(options?: { pdf?: boolean }): Promise<void>
                             // on page idle: start the encoding workers; with pdf, load pdf.js, its worker and decoders
encoderInfo(): string        // where JPEG encoding runs: "4 workers" or "main thread"

interface PdfInfo {
  pageCount: number;
  signed: boolean;                          // electronic signature: compressing makes an unsigned file
  xfa: boolean;                             // XFA form (ANAF): its interactive content won't survive
  kind: 'scanned' | 'digital' | 'mixed';    // from the first, middle and last page
}

interface PhotoInput { file: File; rotation: 0 | 90 | 180 | 270 }

interface EngineOptions {
  targetBytes: number;                      // e.g. 1_000_000
  grayscale: boolean;
  bitonal?: boolean;                        // allow black-and-white (G4) mode for PDFs (§11), default true
  onProgress?: (p: Progress) => void;       // before each page: { dpi, attempt, page, pageCount }
  onAttempt?: (a: AttemptLog) => void;      // after each resolution attempt (dev harness)
  signal?: AbortSignal;                     // cancellation, checked between pages
}

interface EngineResult {
  pdf: Uint8Array;                          // the finished file
  pageCount: number;
  dpi: number;                              // chosen level (0 if unchanged)
  quality: number;                          // chosen JPEG quality (0 if unchanged)
  encoding: 'jpeg' | 'bitonal' | 'unchanged';
  preview: Blob | null;                     // page 1 as JPEG (PNG in black-and-white mode), for the readability check
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
  pdf-source.ts       PDF file → PageSource[], and inspect()   (the only file that imports pdf.js)
  classify.ts         scanned or digital page, from a pdf.js operator list
  photo-source.ts     photos → PageSource[], A4 layouts
  raster.ts           draws a page into the canvas, grayscale, snapshot
  encoder.ts          encoding: worker pool, main-thread fallback
  encode-worker.ts    the worker; runs encode-job.ts
  encode-job.ts       one job on one snapshot: JPEG, black and white (G4), analyse, preview
  bitonal.ts          black-and-white statistics and Otsu thresholding
  g4.ts               CCITT Group 4 encoder (§11)
  search.ts           §5; render and encode are passed in, so it runs without a browser
  assemble.ts         JPEGs → PDF                       (the only file that imports pdf-lib)
  index.ts            public API
  *.test.ts           unit tests (Vitest)
dev/engine.html       harness: run the engine on any file, see every attempt (dev server only)
dev/sample.ts         generates a synthetic scanned document for benchmarks
scripts/bench.mjs     drives headless Chrome to benchmark, snapshot results and check the CSP
scripts/check-g4-tables.mjs   compares the G4 code tables with libtiff's
```

**pdf.js (`pdfjs-dist` 6.5, Apache-2.0)**

- Parsing and image decoding run in pdf.js's own worker. Its script is bundled and served from our site, which `worker-src 'self'` allows.
- At runtime pdf.js loads small WebAssembly decoders for three things:
  - JBIG2 images, which are common in black-and-white scans
  - JPEG 2000 images
  - colour profiles

  `vite.config.ts` serves them at `/pdfjs/<version>/wasm/` in dev and copies them there in the build, with their licences. The version in the path lets `_headers` mark them cacheable forever.
- `warmUp({ pdf: true })` downloads the decoders (about 420 KB) into memory while the page is idle. pdf.js then gets them through a small `BinaryDataFactory` (`useWorkerFetch: false`) instead of fetching them itself. As a result, processing a file makes no network requests at all and works offline, which `scripts/ui-test.mjs` checks.
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

1. **Unit tests** (46):
   - the search against brute force, and how many pages it renders
   - abandoned and failed levels, cancellation, PDF overhead overshoot
   - the photo layout maths
   - pdf-lib's real overhead against `pdfOverhead()`
2. **Dev harness**, `/dev/engine.html`. Pick a file and a target to see each attempt (dpi, pages, qualities that fit, time), the result, page 1 at 100% zoom and a download link. To try it on a phone on the same Wi-Fi, start the dev server with `npm run dev -- --host`.
3. **Benchmark script:** headless Chrome over the DevTools protocol, with no extra dependencies.
   - Times jobs and counts main-thread stalls over 50 ms.
   - Renders results back to PNG for checking by eye.
   - With `PROD=1`, runs against a production build served with the real headers. It checks that pdf.js's decoders compile under the CSP and that a request to another origin is blocked by `connect-src`.

**Acceptance check passed** on public-domain scans downloaded for testing (kept in `test-files/web/`, never committed):

| Scan | Target | Result | Time |
|---|---|---|---|
| 1926 typewriter manual (Internet Archive), 9 pages, 600 dpi JPEG, **79 MB** | 1 MB | 965 KB at 250 dpi, q 0.55; readable when zoomed | 4.9 s |
| NASA report, 12 pages, black-and-white CCITT with an OCR layer, 3.7 MB | 1 MB | 906 KB at 100 dpi, q 0.45; readable at 100% | 2.0 s |
| Internet Archive book, 140 pages, JBIG2 + JPEG 2000, 13.1 MB | 5 MB | 4.75 MB at 100 dpi | 73 s |

The last one exercises pdf.js's WebAssembly decoders. They work, but JPEG 2000 decoding takes about 0.45 s per page.

**Still to do:** time the engine on a phone.

## 10. Findings from real files

The engine was run on ten everyday PDFs and six phone photos. Scans and photos work as intended, but three kinds of file need handling in the UI:

1. **Digitally born PDFs grow when rasterized.** Invoices, contracts and papers store text as text, which is far smaller than a picture of it.
   - A 58-page, 0.9 MB paper can't get under 5 MB as images.
   - A 6-page, 1.1 MB contract can't get under 500 KB.

   For these files the engine either reports `target-unreachable` or reaches the target only at the lowest settings. A size-reduction path that keeps text (recompress only the embedded images) would help them, and it's the natural next feature after the MVP.
2. **Digitally signed PDFs lose their signature.** Rasterizing creates a new document, so the electronic signature is gone. 4 of the 10 PDFs were signed (invoices, ANAF forms, company documents). Portals that check signatures will reject the result, so the UI must warn before compressing a signed PDF. If the file already fits, it's returned untouched and the signature survives.
3. **XFA forms**, which ANAF uses, are rendered from their static fallback. The interactive form data doesn't survive. These are usually signed as well, and the same warning applies.

4. **Black-and-white scans** are often stored as CCITT fax or JBIG2 images, which are far more compact for text than any JPEG. With JPEG alone, a 3.7 MB, 12-page NASA scan couldn't get under 500 KB. Black-and-white mode (§11) fixes this.

**Detection is implemented** as `inspectPdf()`, so the UI can warn when a file is picked:

- **Signatures and XFA forms:** pdf.js reports them directly (`IsSignaturesPresent`, `IsXFAPresent`).
- **Scanned or digital:** `classify.ts` reads the operator lists of the first, middle and last page. It tracks how much each drawing transform scales area (the absolute value of its determinant, so no full matrices) and finds the largest image's share of the page. At least half the page means a scanned page. OCR'd scans count as scanned, because the rule ignores text.

Results on 17 files:

- every computer-made document (invoices, contract, paper, boarding pass, ANAF forms) is `digital`
- every scan (phone app, CCITT, JBIG2 + JPEG 2000, JPEG) is `scanned`
- a book with an image cover is `mixed`
- signatures and XFA forms were all detected

It usually takes 5–400 ms. Files with JPEG 2000 images can take several seconds, because pdf.js decodes the sampled pages' images, so the UI should show the warnings when they arrive rather than wait for them.

## 11. Black-and-white mode (CCITT G4)

For PDFs that already look black and white, pages are thresholded to 1 bit per pixel and compressed with CCITT Group 4 (ITU-T T.6). That's the compression fax machines and scanners use, and every PDF reader understands it (`/CCITTFaxDecode`, `K = -1`). For text it's typically 5–10× smaller than JPEG, and it's lossless at the chosen resolution, so the search can keep a much higher resolution.

**When it's used** (`index.ts`, `bitonal.ts`):

- Before the search, the first, middle and last page are rendered at 200 dpi and measured for mid-gray pixels (brightness 64–191) and coloured pixels (channel spread over 48).
- Black-and-white mode is used only if every sample has at most 3% mid-gray and 0.05% colour. Measured on real files:

  | Documents | Mid-gray | Colour | Mode |
  |---|---|---|---|
  | Black-and-white scans | 0.5–2.2% | exactly 0% | black and white |
  | Internet Archive books (tinted paper) | — | 3% and up | JPEG |
  | The 1926 typewriter manual (photos, sepia) | — | 43% and up | JPEG |
  | Phone-app scan with a stamp | — | 0.35% | JPEG |
  | Synthetic scan with a blue stamp | — | 0.12% | JPEG |
  | Every digital PDF | — | 1% and up | JPEG |

- A page with any colour in a black-and-white document (a blue stamp on a page that wasn't sampled) stays JPEG at quality 0.65.
- Photos never use this mode. `EngineOptions.bitonal: false` turns it off.

**How:**

- **Thresholding:** the worker thresholds each page at Otsu's cut, the brightness that best separates the dark and light classes. The cut is clamped to 80–180, so paper noise on a blank page stays white.
- **Encoding:** `g4.ts` (about 120 lines of logic) implements T.6. Each row is coded against the row above, in pass, vertical (±3 pixels) or horizontal mode.
- **Search:** it runs as before with a single "quality". A black-and-white page is one job on one worker, so up to 4 pages encode at once, capped by the same pixel limit. Results are still taken in page order.
- **Preview:** for page 1 it's a PNG of the thresholded page.

**How it's verified:**

1. **Tables:** the code tables are written as bit strings, so they can be compared with the standard by eye.
   - Unit tests check they're prefix-free and have the sizes T.4 specifies.
   - `scripts/check-g4-tables.mjs` compares all 208 codes with libtiff's independent `t4.h`: all match.
2. **Hand-worked encodings:** unit tests compare bit-exact output for horizontal, vertical and pass mode.
3. **Round trip through pdf.js's own CCITT decoder** (`node scripts/bench.mjs g4`, also on the production build): 10 test images decode with **0 differing pixels**. The images are random noise, 1-pixel checkerboards and stripes, runs over 2560 pixels, a 1-pixel-wide image, all black, all white and rendered text.

**Results** (desktop):

| NASA scan | Target | JPEG only | Black and white |
|---|---|---|---|
| 12 pages, 3.7 MB | 500 KB | impossible | 483 KB at 300 dpi, 2.1 s |
| same | 300 KB | impossible | 273 KB at 175 dpi, 3.4 s; crisp at 100% |
| 22 pages, 1.1 MB | 500 KB | impossible | 489 KB at 150 dpi, 6.5 s |
| 487 pages, 24.5 MB | 10 MB | impossible | 8.5 MB at 100 dpi, 43 s |

Black-and-white pages take longer than JPEG ones, mostly because these documents vary from page to page: a resolution that almost fits can only be ruled out by encoding nearly every page. The page never froze in any of these runs. On the main-thread fallback (no `OffscreenCanvas`, iOS before 16.4) the results are identical, but thresholding and encoding freeze the page for up to 350 ms at a time.

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
