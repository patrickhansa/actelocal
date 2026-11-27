// Web Worker: runs encoding jobs (encode-job.ts) off the main thread, so the page stays
// responsive. Receives a page snapshot and a job, answers with the job's result.

import { readsPixels, runJob, type Job } from './encode-job';

interface Message {
  id: number;
  bitmap: ImageBitmap;
  job: Job;
}

// Typed loosely: the DOM and WebWorker type libraries can't be loaded together.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<Message>) => void;
  postMessage(message: unknown): void;
};

scope.onmessage = async ({ data: { id, bitmap, job } }) => {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: readsPixels(job) });
    if (!ctx) throw new Error('OffscreenCanvas 2D is not supported');
    const result = await runJob(job, bitmap, { ctx, toBlob: (type, quality) => canvas.convertToBlob({ type, quality }) });
    scope.postMessage({ id, result });
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  } finally {
    bitmap.close();
  }
};
