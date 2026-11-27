// Encoding of page snapshots. Prefers a pool of Web Workers, because the browser's
// canvas.toBlob does much of its work on the main thread and freezes the page; falls back
// to the main thread where workers can't draw (no OffscreenCanvas, e.g. iOS before 16.4).

import type { PageStats } from './bitonal';
import {
  BITONAL_COLOUR_PAGE_QUALITY,
  BITONAL_PAGE_MAX_COLOUR_FRACTION,
  MAX_PARALLEL_ENCODE_PIXELS,
} from './config';
import { readsPixels, runJob, type EncodedImage, type Job, type JobResult } from './encode-job';
import { EngineError } from './types';

export type { EncodedImage } from './encode-job';

/** 'jpeg': colour/gray JPEG at each quality. 'bitonal': black-and-white CCITT G4. */
export type EncodeMode = 'jpeg' | 'bitonal';

export interface ImageEncoder {
  /**
   * Encodes `snapshot` once per quality, in order. In 'bitonal' mode the quality doesn't
   * apply: every entry is the same black-and-white image. Leaves `snapshot` open.
   */
  encode(snapshot: ImageBitmap, qualities: readonly number[], mode: EncodeMode): Promise<EncodedImage[]>;
  /** How black-and-white the snapshot looks. */
  analyze(snapshot: ImageBitmap): Promise<PageStats>;
  /** The snapshot thresholded to black and white, as PNG. */
  bitonalPreview(snapshot: ImageBitmap): Promise<Blob>;
  /** Where encoding runs, for diagnostics: e.g. "3 workers" or "main thread". */
  describe(): string;
  /** How many jobs can usefully run at once. */
  parallelism(): number;
}

let shared: ImageEncoder | null = null;

/** The encoder for this visit: workers if the browser supports them, created once. */
export function imageEncoder(): ImageEncoder {
  shared ??= WorkerPool.supported() ? new WorkerPool(new MainThreadEncoder()) : new MainThreadEncoder();
  return shared;
}

const bitonalJob: Job = {
  kind: 'bitonal',
  maxColourFraction: BITONAL_PAGE_MAX_COLOUR_FRACTION,
  colourPageQuality: BITONAL_COLOUR_PAGE_QUALITY,
};

/** Shared by both encoders: everything except how a single job is run. */
abstract class BaseEncoder implements ImageEncoder {
  abstract describe(): string;
  abstract parallelism(): number;
  protected abstract run(snapshot: ImageBitmap, job: Job): Promise<JobResult>;

  async encode(snapshot: ImageBitmap, qualities: readonly number[], mode: EncodeMode): Promise<EncodedImage[]> {
    if (mode === 'bitonal') {
      const [image] = (await this.run(snapshot, bitonalJob) as { images: EncodedImage[] }).images;
      return qualities.map(() => image);
    }
    return this.encodeJpeg(snapshot, qualities);
  }

  protected async encodeJpeg(snapshot: ImageBitmap, qualities: readonly number[]): Promise<EncodedImage[]> {
    return (await this.run(snapshot, { kind: 'jpeg', qualities: [...qualities] }) as { images: EncodedImage[] }).images;
  }

  async analyze(snapshot: ImageBitmap): Promise<PageStats> {
    return (await this.run(snapshot, { kind: 'analyze' }) as { stats: PageStats }).stats;
  }

  async bitonalPreview(snapshot: ImageBitmap): Promise<Blob> {
    return (await this.run(snapshot, { kind: 'preview' }) as { preview: Blob }).preview;
  }
}

interface Reply {
  id: number;
  result?: JobResult;
  error?: string;
}

class WorkerPool extends BaseEncoder {
  private readonly workers: { worker: Worker; busy: number }[] = [];
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private nextId = 0;
  private broken = false;
  private readonly fallback: MainThreadEncoder;

  static supported(): boolean {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype;
  }

  constructor(fallback: MainThreadEncoder) {
    super();
    this.fallback = fallback;
    const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./encode-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        this.pending.get(data.id)?.(data);
        this.pending.delete(data.id);
      };
      worker.onerror = () => this.fail();
      this.workers.push({ worker, busy: 0 });
    }
  }

  describe(): string {
    return this.broken ? `${this.fallback.describe()} (workers failed)` : `${this.workers.length} workers`;
  }

  parallelism(): number {
    return this.broken ? 1 : this.workers.length;
  }

  /** JPEG qualities are split across workers, each with its own copy of the snapshot. */
  protected async encodeJpeg(snapshot: ImageBitmap, qualities: readonly number[]): Promise<EncodedImage[]> {
    if (this.broken) return this.fallback.encode(snapshot, qualities, 'jpeg');
    // Copies in flight are capped by pixel count to bound memory on phones.
    const pixels = snapshot.width * snapshot.height;
    const lanes = Math.max(
      1,
      Math.min(qualities.length, this.workers.length, Math.floor(MAX_PARALLEL_ENCODE_PIXELS / pixels)),
    );
    const groups = Array.from({ length: lanes }, (_, lane) => qualities.filter((_, i) => i % lanes === lane));
    const results = await Promise.all(groups.map((group) => super.encodeJpeg(snapshot, group)));
    return qualities.map((_, i) => results[i % lanes][Math.floor(i / lanes)]);
  }

  protected async run(snapshot: ImageBitmap, job: Job): Promise<JobResult> {
    if (this.broken) return this.fallback.runOnMainThread(snapshot, job);
    try {
      return await this.post(await createImageBitmap(snapshot), job);
    } catch {
      this.fail();
      return this.fallback.runOnMainThread(snapshot, job);
    }
  }

  private post(bitmap: ImageBitmap, job: Job): Promise<JobResult> {
    const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    slot.busy++;
    return new Promise<JobResult>((resolve, reject) => {
      this.pending.set(id, ({ result, error }) => {
        slot.busy--;
        if (result) resolve(result);
        else reject(new Error(error));
      });
      slot.worker.postMessage({ id, bitmap, job }, [bitmap]);
    });
  }

  /** A worker failed: use the main thread from now on and settle anything still waiting. */
  private fail(): void {
    this.broken = true;
    for (const [id, settle] of this.pending) settle({ id, error: 'worker failed' });
    this.pending.clear();
  }
}

/** Runs jobs on the main thread, one at a time on one scratch canvas. */
class MainThreadEncoder extends BaseEncoder {
  private readonly canvas = document.createElement('canvas');
  private queue: Promise<unknown> = Promise.resolve();

  describe(): string {
    return 'main thread';
  }

  parallelism(): number {
    return 1;
  }

  runOnMainThread(snapshot: ImageBitmap, job: Job): Promise<JobResult> {
    return this.run(snapshot, job);
  }

  protected run(snapshot: ImageBitmap, job: Job): Promise<JobResult> {
    const result = this.queue.then(() => {
      const { canvas } = this;
      canvas.width = snapshot.width;
      canvas.height = snapshot.height;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: readsPixels(job) })!;
      return runJob(job, snapshot, { ctx, toBlob: (type, quality) => toBlob(canvas, type, quality) });
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new EngineError('render-failed'))), type, quality);
  });
}
