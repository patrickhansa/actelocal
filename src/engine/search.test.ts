import { describe, expect, it } from 'vitest';
import { LAST_RESORT_QUALITIES, LEVELS_DPI, QUALITIES, pdfOverhead } from './config';
import { searchSettings, type SearchInput, type Sized } from './search';
import { EngineError, type AttemptLog } from './types';

// A size model that behaves like real JPEGs: bigger with more pixels and with higher quality.
// `complexity` scales each page (1 = a typical scanned A4 page, 0.1 = a nearly blank one).
const A4_PIXELS_AT_1_DPI = (595.28 / 72) * (841.89 / 72);
const bytesPerPixel = (quality: number) => 0.05 + 0.4 * quality ** 3;
const jpegSize = (complexity: number, dpi: number, quality: number) =>
  Math.round(A4_PIXELS_AT_1_DPI * dpi * dpi * bytesPerPixel(quality) * complexity);

const STRUCTURE_BYTES = 700; // what the fake assembler adds; below pdfOverhead() as in reality

function fakeDocument(complexities: number[], targetBytes: number, extra: Partial<SearchInput<Sized>> = {}) {
  const renders: { page: number; dpi: number; released: boolean }[] = [];
  const attempts: AttemptLog[] = [];
  const input: SearchInput<Sized> = {
    pageCount: complexities.length,
    targetBytes,
    renderPage: async (page, dpi) => {
      const render = { page, dpi, released: false };
      renders.push(render);
      return {
        encode: async (qualities) => qualities.map((q) => ({ size: jpegSize(complexities[page], dpi, q) })),
        release: () => {
          expect(render.released, 'released twice').toBe(false);
          render.released = true;
        },
      };
    },
    assemble: async (jpegs) => new Uint8Array(jpegs.reduce((sum, j) => sum + j.size, 0) + STRUCTURE_BYTES),
    onAttempt: (attempt) => attempts.push(attempt),
    ...extra,
  };
  return { input, renders, attempts };
}

/** The answer by brute force: the first level where some allowed quality fits, at its highest such quality. */
function expectedSettings(complexities: number[], targetBytes: number) {
  const budget = targetBytes - pdfOverhead(complexities.length);
  for (const [i, dpi] of LEVELS_DPI.entries()) {
    const qualities = i === LEVELS_DPI.length - 1 ? LAST_RESORT_QUALITIES : QUALITIES;
    const fitting = qualities.filter(
      (q) => complexities.reduce((sum, c) => sum + jpegSize(c, dpi, q), 0) <= budget,
    );
    if (fitting.length > 0) return { dpi, quality: Math.max(...fitting) };
  }
  return null;
}

const documents: Record<string, number[]> = {
  'one page': [1],
  'ten similar scans': [1, 0.9, 1.1, 1, 0.95, 1.05, 1, 0.9, 1.1, 1],
  'dense pages then blank ones': [1.5, 1.4, 0.1, 0.1, 0.1, 0.1],
  'blank pages then dense ones': [0.1, 0.1, 0.1, 1.5, 1.4, 1.6],
};

describe('searchSettings', () => {
  for (const [name, complexities] of Object.entries(documents)) {
    it(`matches brute force for ${name}, across targets from 30 KB to 30 MB`, async () => {
      for (let target = 30_000; target <= 30_000_000; target = Math.round(target * 1.17)) {
        const expected = expectedSettings(complexities, target);
        const { input } = fakeDocument(complexities, target);
        if (expected === null) {
          await expect(searchSettings(input)).rejects.toMatchObject({ code: 'target-unreachable' });
          continue;
        }
        const result = await searchSettings(input);
        expect({ dpi: result.dpi, quality: result.quality }, `target ${target}`).toEqual(expected);
        expect(result.pdf.length).toBeLessThanOrEqual(target);
        expect(result.jpegs).toHaveLength(complexities.length);
      }
    });
  }

  it('releases every page it renders, whatever the outcome', async () => {
    for (const target of [100_000, 1_000_000, 100_000_000]) {
      const { input, renders } = fakeDocument(documents['ten similar scans'], target);
      await searchSettings(input).catch(() => undefined);
      expect(renders.every((r) => r.released)).toBe(true);
    }
  });

  it('renders at most about twice the page count for similar pages, at any target', async () => {
    const pages = documents['ten similar scans'];
    let worst = 0;
    for (let target = 300_000; target <= 30_000_000; target = Math.round(target * 1.17)) {
      const { input, renders } = fakeDocument(pages, target);
      await searchSettings(input).catch(() => undefined);
      worst = Math.max(worst, renders.length);
    }
    expect(worst).toBeLessThanOrEqual(2 * pages.length + 2);
  });

  it('takes the best settings at once when the target is generous', async () => {
    const { input, attempts } = fakeDocument([1, 1, 1], 100_000_000);
    const result = await searchSettings(input);
    expect(result).toMatchObject({ dpi: 300, quality: 0.85 });
    expect(attempts).toHaveLength(1);
  });

  it('abandons a resolution that is far too big after a page or two', async () => {
    const { input, attempts } = fakeDocument(documents['ten similar scans'], 1_000_000);
    await searchSettings(input);
    expect(attempts[0]).toMatchObject({ dpi: 300, fittingQualities: [] });
    expect(attempts[0].pagesRendered).toBeLessThanOrEqual(2);
  });

  it('goes below quality 0.55 only at the last resolution', async () => {
    const pages = documents['ten similar scans'];
    // Fits at 100 dpi with quality 0.45 but not 0.55.
    const target = pages.reduce((sum, c) => sum + jpegSize(c, 100, 0.45), 0) + pdfOverhead(pages.length);
    const result = await searchSettings(fakeDocument(pages, target).input);
    expect(result).toMatchObject({ dpi: 100, quality: 0.45 });
  });

  it('reports the smallest achievable size when the target is unreachable', async () => {
    const pages = documents['ten similar scans'];
    const smallest = pages.reduce((sum, c) => sum + jpegSize(c, 100, 0.35), 0);
    const error: EngineError = await searchSettings(fakeDocument(pages, smallest / 2).input).catch((e) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error.code).toBe('target-unreachable');
    expect(error.detail.smallestBytes).toBeGreaterThan(smallest * 0.8);
    expect(error.detail.smallestBytes).toBeLessThan(smallest * 1.3);
  });

  it('falls back to a lower quality when the assembled PDF overshoots', async () => {
    const pages = [1, 1];
    const target = 1_000_000;
    const naive = expectedSettings(pages, target)!;
    const naiveJpegBytes = pages.reduce((sum, c) => sum + jpegSize(c, naive.dpi, naive.quality), 0);
    // An assembler with more structure than estimated pushes the naive choice 1 byte over the target.
    const extra = target - naiveJpegBytes + 1;
    const { input } = fakeDocument(pages, target, {
      assemble: async (jpegs) => new Uint8Array(jpegs.reduce((sum, j) => sum + j.size, 0) + extra),
    });
    const result = await searchSettings(input);
    expect(result.pdf.length).toBeLessThanOrEqual(target);
    expect(result.dpi * 10 + result.quality).toBeLessThan(naive.dpi * 10 + naive.quality);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const { input } = fakeDocument([1, 1, 1], 1_000_000, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(searchSettings(input)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects an empty document', async () => {
    await expect(searchSettings(fakeDocument([], 1_000_000).input)).rejects.toMatchObject({ code: 'no-pages' });
  });
});
