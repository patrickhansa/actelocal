// Packs one JPEG per page into a new PDF. See docs/engine-design.md §6.

import { PDFDocument } from 'pdf-lib';
import type { PageSource } from './types';

type PageSize = Pick<PageSource, 'widthPt' | 'heightPt'>;

/** Anything that can hand over its bytes: a Blob in the browser, a stub in tests. */
export interface JpegBytes {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Builds a fresh PDF: page i has size pages[i] and shows jpegs[i] across the whole page.
 * The JPEG bytes are embedded unchanged. Nothing from any input file's metadata is copied.
 */
export async function assemblePdf(pages: readonly PageSize[], jpegs: readonly JpegBytes[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('ActeLocal');
  doc.setCreator('ActeLocal');

  for (const [i, jpeg] of jpegs.entries()) {
    const { widthPt, heightPt } = pages[i];
    const image = await doc.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    const page = doc.addPage([widthPt, heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  }

  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
