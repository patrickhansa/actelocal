// One encoding job on one page snapshot. Runs in a Web Worker (encode-worker.ts) or, as a
// fallback, on the main thread (encoder.ts): both hand in a 2D surface of the snapshot's size.

import { bitsToRgba, pageStats, threshold, type PageStats } from './bitonal';
import { encodeG4 } from './g4';

/** An encoded page image, ready to embed in the PDF. */
export interface EncodedImage {
  format: 'jpeg' | 'g4';
  blob: Blob;
  width: number;
  height: number;
  /** Bytes, same as blob.size. */
  size: number;
}

export type Job =
  /** JPEG at each quality. */
  | { kind: 'jpeg'; qualities: number[] }
  /** Black and white (CCITT G4), unless the page has colour: then one JPEG at `colourPageQuality`. */
  | { kind: 'bitonal'; maxColourFraction: number; colourPageQuality: number }
  /** How black-and-white the page looks. */
  | { kind: 'analyze' }
  /** The page thresholded to black and white, as PNG, for the readability preview. */
  | { kind: 'preview' };

export type JobResult = { images: EncodedImage[] } | { stats: PageStats } | { preview: Blob };

export interface Surface {
  readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  toBlob(type: string, quality?: number): Promise<Blob>;
}

/** Whether a job reads pixels back (the surface should then be CPU-backed). */
export const readsPixels = (job: Job) => job.kind !== 'jpeg';

export async function runJob(job: Job, bitmap: ImageBitmap, surface: Surface): Promise<JobResult> {
  const { width, height } = bitmap;
  const { ctx } = surface;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = () => ctx.getImageData(0, 0, width, height).data;
  const jpeg = async (quality: number): Promise<EncodedImage> => {
    const blob = await surface.toBlob('image/jpeg', quality);
    return { format: 'jpeg', blob, width, height, size: blob.size };
  };

  switch (job.kind) {
    case 'jpeg':
      return { images: await Promise.all(job.qualities.map(jpeg)) };
    case 'analyze':
      return { stats: pageStats(pixels()) };
    case 'bitonal': {
      const rgba = pixels();
      if (pageStats(rgba).colourFraction > job.maxColourFraction) {
        return { images: [await jpeg(job.colourPageQuality)] };
      }
      const data = encodeG4(threshold(rgba), width, height);
      return { images: [{ format: 'g4', blob: new Blob([data as Uint8Array<ArrayBuffer>]), width, height, size: data.length }] };
    }
    case 'preview': {
      const rgba = bitsToRgba(threshold(pixels()));
      ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
      return { preview: await surface.toBlob('image/png') };
    }
  }
}
