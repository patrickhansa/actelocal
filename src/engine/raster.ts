// Draws pages into canvases and encodes them as JPEG. See docs/engine-design.md §4.

import { MAX_LONG_EDGE_PT, MAX_PARALLEL_ENCODE_PIXELS, PT_PER_INCH } from './config';
import { EngineError, type PageSource } from './types';

/** Pixels per PDF point for `page` at `dpi`, scaled down for pages larger than A4. */
export function pixelsPerPoint(page: Pick<PageSource, 'widthPt' | 'heightPt'>, dpi: number): number {
  const longEdge = Math.max(page.widthPt, page.heightPt);
  return (dpi / PT_PER_INCH) * Math.min(1, MAX_LONG_EDGE_PT / longEdge);
}

interface Buffer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Two canvases used in turn: page n+1 is drawn into one while page n is still being
 * encoded from the other. An encoder returned by render() stays valid until the render
 * after next starts.
 */
export class Rasterizer {
  private readonly buffers: [Buffer, Buffer];
  private turn = 0;
  private readonly grayscale: boolean;
  private readonly encodeSlots = new PixelBudget(MAX_PARALLEL_ENCODE_PIXELS);

  constructor(grayscale: boolean) {
    this.grayscale = grayscale;
    this.buffers = [createBuffer(), createBuffer()];
  }

  /** Draws `page` at `dpi` and returns a function that encodes the result as JPEG. */
  async render(page: PageSource, dpi: number): Promise<(quality: number) => Promise<Blob>> {
    const { canvas, ctx } = this.buffers[this.turn];
    this.turn = 1 - this.turn;

    const pxPerPt = pixelsPerPoint(page, dpi);
    const width = Math.max(1, Math.round(page.widthPt * pxPerPt));
    const height = Math.max(1, Math.round(page.heightPt * pxPerPt));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; // resizing also resets the context state
      canvas.height = height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.draw(ctx, pxPerPt);

    if (this.grayscale) {
      // The 'color' blend keeps each pixel's luminosity and takes hue and saturation
      // from the fill, which is a gray: the page turns grayscale in one GPU-friendly draw.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'color';
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }

    return (quality) => this.encodeSlots.run(width * height, () => encodeJpeg(canvas, quality));
  }

  /** Frees the canvas memory now; iOS Safari otherwise holds it until the page closes. */
  dispose(): void {
    for (const { canvas } of this.buffers) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function createBuffer(): Buffer {
  const canvas = document.createElement('canvas');
  // Opaque canvas: no alpha channel to composite or encode.
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new EngineError('render-failed');
  return { canvas, ctx };
}

/** The browser copies the canvas when toBlob is called, then encodes on another thread. */
function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new EngineError('render-failed'))), 'image/jpeg', quality);
  });
}

/** Runs tasks in parallel while their combined pixel count stays under a limit. */
class PixelBudget {
  private inUse = 0;
  private waiting: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(pixels: number, task: () => Promise<T>): Promise<T> {
    // A task larger than the limit still runs, alone.
    while (this.inUse > 0 && this.inUse + pixels > this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.inUse += pixels;
    try {
      return await task();
    } finally {
      this.inUse -= pixels;
      for (const wake of this.waiting.splice(0)) wake();
    }
  }
}
