// Generates a synthetic scanned document for benchmarks: 300 dpi JPEG pages with
// paper tone, body text, small print, a stamp, a signature and sensor noise. Dev only.

import { PDFDocument } from 'pdf-lib';

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore ' +
  'et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ' +
  'ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla'
).split(' ');

/** Small deterministic PRNG (mulberry32), so every run produces the same file. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function makeScanPdf(pageCount: number, noise = 10, dpi = 300): Promise<Uint8Array> {
  const width = Math.round(8.27 * dpi);
  const height = Math.round(11.69 * dpi);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rand = prng(42);
  const word = () => WORDS[Math.floor(rand() * WORDS.length)];
  const doc = await PDFDocument.create();

  for (let p = 0; p < pageCount; p++) {
    const paper = ctx.createLinearGradient(0, 0, width, height);
    paper.addColorStop(0, '#f4f1ea');
    paper.addColorStop(1, '#e4dfd4');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((rand() - 0.5) * 0.012); // slightly crooked, like a real scan
    ctx.translate(-width / 2, -height / 2);

    ctx.fillStyle = '#1b1b1b';
    ctx.font = `bold ${dpi * 0.22}px serif`;
    ctx.fillText(`CERTIFICATE No. ${1000 + p}`, dpi * 0.8, dpi * 1.2);

    ctx.font = `${dpi * 0.155}px serif`; // about 11 pt
    const right = width - dpi * 0.8;
    for (let y = dpi * 1.8; y < height - dpi * 2.2; y += dpi * 0.25) {
      let line = word();
      while (ctx.measureText(`${line} ${word()}`).width < right - dpi * 0.8 - dpi * 0.3) line += ` ${word()}`;
      ctx.fillText(line, dpi * 0.8, y);
      if (rand() < 0.12) y += dpi * 0.15; // paragraph break
    }

    ctx.font = `${dpi * 0.09}px sans-serif`; // about 6.5 pt small print
    for (let i = 0; i < 3; i++) {
      ctx.fillText(Array.from({ length: 22 }, word).join(' '), dpi * 0.8, height - dpi * (1.4 - i * 0.14));
    }

    ctx.strokeStyle = 'rgba(30, 60, 160, 0.75)';
    ctx.fillStyle = 'rgba(30, 60, 160, 0.75)';
    ctx.lineWidth = dpi * 0.02;
    ctx.beginPath();
    ctx.arc(width - dpi * 2, height - dpi * 2.6, dpi * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${dpi * 0.1}px sans-serif`;
    ctx.fillText('STAMP', width - dpi * 2.25, height - dpi * 2.56);

    ctx.beginPath(); // signature
    ctx.moveTo(dpi * 1, height - dpi * 2.5);
    for (let i = 0; i < 6; i++) {
      ctx.bezierCurveTo(
        dpi * (1.2 + i * 0.3), height - dpi * (2.9 - rand() * 0.3),
        dpi * (1.3 + i * 0.3), height - dpi * (2.2 + rand() * 0.3),
        dpi * (1.4 + i * 0.3), height - dpi * 2.5,
      );
    }
    ctx.stroke();
    ctx.restore();

    if (noise > 0) {
      const image = ctx.getImageData(0, 0, width, height);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        const n = (rand() - 0.5) * 2 * noise;
        data[i] += n;
        data[i + 1] += n;
        data[i + 2] += n;
      }
      ctx.putImageData(image, 0, 0);
    }

    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.88));
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    doc.addPage([595.28, 841.89]).drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }

  canvas.width = canvas.height = 0;
  return doc.save();
}
