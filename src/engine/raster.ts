// Draws pages into a canvas and hands snapshots to the encoder. See docs/engine-design.md §4.

import type { PageStats } from './bitonal';
import { MAX_LONG_EDGE_PT, PT_PER_INCH } from './config';
import { imageEncoder, type EncodedImage, type EncodeMode, type ImageEncoder } from './encoder';
import type { RenderedPage } from './search';
import { EngineError, type PageSource } from './types';

/** Pixels per PDF point for `page` at `dpi`, scaled down for pages larger than A4. */
export function pixelsPerPoint(page: Pick<PageSource, 'widthPt' | 'heightPt'>, dpi: number): number {
  const longEdge = Math.max(page.widthPt, page.heightPt);
  return (dpi / PT_PER_INCH) * Math.min(1, MAX_LONG_EDGE_PT / longEdge);
}

/** A rendered page: encode it, check how black-and-white it is, or preview it thresholded. */
export interface RasterPage extends RenderedPage<EncodedImage> {
  analyze(): Promise<PageStats>;
  bitonalPreview(): Promise<Blob>;
}

/**
 * Draws one page at a time. Each render ends with a snapshot of the canvas, so the canvas
 * is free for the next page while the snapshot is still being encoded.
 */
export class Rasterizer {
  /** How pages are encoded; set once the document has been analysed. */
  mode: EncodeMode = 'jpeg';
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly grayscale: boolean;
  private readonly encoder: ImageEncoder;

  constructor(grayscale: boolean) {
    this.grayscale = grayscale;
    this.encoder = imageEncoder();
    this.canvas = document.createElement('canvas');
    // Opaque canvas: no alpha channel to composite or encode.
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new EngineError('render-failed');
    this.ctx = ctx;
  }

  /** Draws `page` at `dpi`. */
  async render(page: PageSource, dpi: number): Promise<RasterPage> {
    const { canvas, ctx } = this;
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

    let snapshot: ImageBitmap;
    try {
      snapshot = await createImageBitmap(canvas);
    } catch (error) {
      throw new EngineError('render-failed', {}, { cause: error });
    }
    const mode = this.mode;
    return {
      encode: (qualities) => this.encoder.encode(snapshot, qualities, mode),
      analyze: () => this.encoder.analyze(snapshot),
      bitonalPreview: () => this.encoder.bitonalPreview(snapshot),
      release: () => snapshot.close(),
    };
  }

  /** Frees the canvas memory now; iOS Safari otherwise holds it until the page closes. */
  dispose(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
