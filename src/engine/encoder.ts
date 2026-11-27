// JPEG encoding of page snapshots. Prefers a pool of Web Workers, because the browser's
// canvas.toBlob does much of its work on the main thread and freezes the page; falls back
// to toBlob where workers can't draw (no OffscreenCanvas, e.g. iOS before 16.4).

import { MAX_PARALLEL_ENCODE_PIXELS } from './config';
import { EngineError } from './types';

export interface JpegEncoder {
  /** Encodes `snapshot` at each quality, in order. Leaves `snapshot` open. */
  encode(snapshot: ImageBitmap, qualities: readonly number[]): Promise<Blob[]>;
  /** Where encoding runs, for diagnostics: e.g. "3 workers" or "main thread". */
  describe(): string;
}

let shared: JpegEncoder | null = null;

/** The encoder for this visit: workers if the browser supports them, created once. */
export function jpegEncoder(): JpegEncoder {
  shared ??= WorkerPool.supported() ? new WorkerPool(new MainThreadEncoder()) : new MainThreadEncoder();
  return shared;
}

interface Reply {
  id: number;
  blobs?: Blob[];
  error?: string;
}

class WorkerPool implements JpegEncoder {
  private readonly workers: { worker: Worker; busy: number }[] = [];
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private nextId = 0;
  private broken = false;
  private readonly fallback: JpegEncoder;

  static supported(): boolean {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype;
  }

  constructor(fallback: JpegEncoder) {
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

  async encode(snapshot: ImageBitmap, qualities: readonly number[]): Promise<Blob[]> {
    if (this.broken) return this.fallback.encode(snapshot, qualities);
    // Split the qualities across workers; each gets its own copy of the snapshot. The number
    // of copies in flight is capped by pixel count to bound memory on phones.
    const pixels = snapshot.width * snapshot.height;
    const lanes = Math.max(
      1,
      Math.min(qualities.length, this.workers.length, Math.floor(MAX_PARALLEL_ENCODE_PIXELS / pixels)),
    );
    const groups = Array.from({ length: lanes }, (_, lane) => qualities.filter((_, i) => i % lanes === lane));
    try {
      const results = await Promise.all(groups.map(async (group) => this.run(await createImageBitmap(snapshot), group)));
      return qualities.map((_, i) => results[i % lanes][Math.floor(i / lanes)]);
    } catch {
      this.fail();
      return this.fallback.encode(snapshot, qualities);
    }
  }

  private run(bitmap: ImageBitmap, qualities: number[]): Promise<Blob[]> {
    const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    slot.busy++;
    return new Promise<Blob[]>((resolve, reject) => {
      this.pending.set(id, ({ blobs, error }) => {
        slot.busy--;
        if (blobs) resolve(blobs);
        else reject(new Error(error));
      });
      slot.worker.postMessage({ id, bitmap, qualities }, [bitmap]);
    });
  }

  /** A worker failed: use the main thread from now on and settle anything still waiting. */
  private fail(): void {
    this.broken = true;
    for (const [id, settle] of this.pending) settle({ id, error: 'worker failed' });
    this.pending.clear();
  }
}

/** Encodes with canvas.toBlob on the main thread. */
class MainThreadEncoder implements JpegEncoder {
  private readonly canvas = document.createElement('canvas');
  private queue: Promise<unknown> = Promise.resolve();

  describe(): string {
    return 'main thread';
  }

  encode(snapshot: ImageBitmap, qualities: readonly number[]): Promise<Blob[]> {
    // One scratch canvas, so calls run one after another.
    const result = this.queue.then(() => {
      const { canvas } = this;
      canvas.width = snapshot.width;
      canvas.height = snapshot.height;
      canvas.getContext('2d', { alpha: false })!.drawImage(snapshot, 0, 0);
      return Promise.all(qualities.map((quality) => toJpeg(canvas, quality)));
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new EngineError('render-failed'))), 'image/jpeg', quality);
  });
}
