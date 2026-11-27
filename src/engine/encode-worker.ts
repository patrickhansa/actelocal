// Web Worker: encodes page snapshots as JPEG off the main thread, so the page stays
// responsive. Receives an ImageBitmap and the qualities wanted, answers with one Blob each.

interface Job {
  id: number;
  bitmap: ImageBitmap;
  qualities: number[];
}

// Typed loosely: the DOM and WebWorker type libraries can't be loaded together.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<Job>) => void;
  postMessage(message: unknown): void;
};

scope.onmessage = async ({ data: { id, bitmap, qualities } }) => {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('OffscreenCanvas 2D is not supported');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blobs = await Promise.all(qualities.map((quality) => canvas.convertToBlob({ type: 'image/jpeg', quality })));
    scope.postMessage({ id, blobs });
  } catch (error) {
    bitmap.close();
    scope.postMessage({ id, error: String(error) });
  }
};
