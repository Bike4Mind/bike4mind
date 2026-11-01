import {
  PDF_INPUT_MAX,
  PDF_MAX_PAGES,
  TEXT_BYTE_CAP,
  capText,
  formatBytes,
  sanitizeName,
  type PrepareResult,
} from './attachments';

export interface PdfText {
  text: string;
  pages: number;
}

/** A PDF that cannot be turned into text; `reason` is written for the user. */
export class PdfExtractionError extends Error {}

/**
 * The document's text, one string, or a PdfExtractionError saying why there is none.
 *
 * `unpdf` is imported on first use: it carries a bundled pdf.js, which a launch that never sees
 * a PDF should not pay to load.
 */
export async function extractPdfText(bytes: Uint8Array, maxPages = PDF_MAX_PAGES): Promise<PdfText> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy, never the Buffer itself: a small Buffer is a view into Node's shared allocation
    // pool, and pdf.js transfers (detaches) what it is given.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new PdfExtractionError(
      name === 'PasswordException'
        ? 'That PDF is password-protected. Remove the password and attach it again.'
        : 'That PDF could not be read. It may be damaged.'
    );
  }

  try {
    if (pdf.numPages > maxPages) {
      throw new PdfExtractionError(`That PDF has ${pdf.numPages} pages; the limit is ${maxPages}.`);
    }
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: text.trim(), pages: pdf.numPages };
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    throw new PdfExtractionError('That PDF could not be read. It may be damaged.');
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}

/** Text of a PDF's pages, capped for the prompt. Truncation is marked inside the text itself. */
export function capPdfText(text: string): { text: string; truncated: boolean } {
  const full = Buffer.from(text, 'utf8');
  const capped = capText(full.subarray(0, TEXT_BYTE_CAP + 1), full.length, 'extracted text');
  return { text: capped.bytes.toString('utf8'), truncated: capped.truncated };
}

/**
 * Validate a PDF at intake. The ORIGINAL bytes are what is stored, so a later change to send the
 * document natively needs no re-attach; the text is re-extracted when a turn is sent.
 */
export async function preparePdf(name: string, bytes: Buffer): Promise<PrepareResult> {
  const sourceBytes = bytes.length;
  if (sourceBytes === 0) return { ok: false, reason: 'That file is empty.' };
  if (sourceBytes > PDF_INPUT_MAX) {
    return {
      ok: false,
      reason: `That PDF is ${formatBytes(sourceBytes)}; the limit is ${formatBytes(PDF_INPUT_MAX)}.`,
    };
  }

  let extracted: PdfText;
  try {
    extracted = await extractPdfText(bytes);
  } catch (err) {
    if (err instanceof PdfExtractionError) return { ok: false, reason: err.message };
    throw err;
  }
  if (extracted.text.length === 0) {
    return {
      ok: false,
      reason: 'That PDF has no text to extract; it looks like scanned images. Attach screenshots of the pages instead.',
    };
  }

  return {
    ok: true,
    prepared: {
      kind: 'pdf',
      name: sanitizeName(name),
      mediaType: 'application/pdf',
      bytes,
      sourceBytes,
      pages: extracted.pages,
      ...(capPdfText(extracted.text).truncated ? { truncated: true } : {}),
    },
  };
}
