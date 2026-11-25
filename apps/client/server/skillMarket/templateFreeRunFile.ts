/**
 * The one file a visitor may attach to a template free run (pages/api/skills/template/run/[slug].ts).
 * It is read in memory for that request only: never written to storage, S3 or the database.
 */

/** What the run sends the model: an image as a `data:` URL, a PDF or text file as its text. */
export type FreeRunFile =
  { kind: 'image'; name: string; dataUrl: string } | { kind: 'document'; name: string; text: string };

export type FreeRunFileRefusal = { status: number; code: string; error: string };

export type FreeRunFileLimits = { maxBytes: number; maxPages: number };

/**
 * A hosted request body tops out near 6 MB and the file arrives base64-encoded (4/3 larger) next to
 * the pasted text, so no admin cap can admit more than this.
 */
export const FREE_RUN_FILE_TRANSPORT_MAX_BYTES = 4 * 1024 * 1024;

/** The request body ceiling for the run route: the largest file once base64-encoded, plus the text. */
export const FREE_RUN_BODY_MAX_BYTES = Math.ceil((FREE_RUN_FILE_TRANSPORT_MAX_BYTES * 4) / 3) + 256 * 1024;

/** Bounds the tokens one file's text can add, about 15k tokens: ten dense pages fit. */
export const FREE_RUN_FILE_TEXT_MAX_CHARS = 60_000;

export const FREE_RUN_FILE_ACCEPT =
  'application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain,.txt,.md,.csv';

/** Whether a stored file is one of the FREE_RUN_FILE_ACCEPT types, by its mime type or name. */
export function isFreeRunFileType(mime: string, name: string): boolean {
  const accept = FREE_RUN_FILE_ACCEPT.split(',');
  const base = mime.split(';')[0].trim().toLowerCase();
  const lower = name.toLowerCase();
  return accept.some(entry => (entry.startsWith('.') ? lower.endsWith(entry) : entry === base));
}

export const freeRunFileMaxBytes = (maxMb: number): number =>
  Math.min(Math.floor(maxMb * 1024 * 1024), FREE_RUN_FILE_TRANSPORT_MAX_BYTES);

export const formatFileCap = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.floor(bytes / 1024))} KB`
    : `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;

const refusal = (code: string, error: string, status = 400): FreeRunFileRefusal => ({ status, code, error });

export const FILE_NOT_SUPPORTED = refusal('file_not_supported', 'This skill takes text only. Paste your text instead.');
const TOO_MANY_FILES = refusal('too_many_files', 'Attach one file only.');
const MALFORMED = refusal('file_invalid', 'The file could not be read. Try another file.');
const UNSUPPORTED_TYPE = refusal(
  'file_type_unsupported',
  'Attach a PDF, an image (PNG, JPEG, GIF or WebP) or a text file.'
);
const NO_TEXT = refusal('file_no_text', 'No text could be read from this file. Paste the text instead.');
const TOO_MUCH_TEXT = refusal('file_text_too_long', 'This file has too much text for a free run. Try a shorter one.');

const IMAGE_SIGNATURES: { mediaType: string; test: (b: Buffer) => boolean }[] = [
  {
    mediaType: 'image/png',
    test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mediaType: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/gif', test: b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  {
    mediaType: 'image/webp',
    test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TEXT_NAME = /\.(txt|md|markdown|csv)$/i;

/** A display name safe to quote to the model: no control characters, bounded. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (cleaned || 'file').slice(0, 120);
}

/**
 * Validates the request's `file` (and refuses a second one) against the caps, then reads it. Every
 * refusal happens before any cap is reserved or model called. `null` means no file was sent.
 */
export async function readFreeRunFile(
  body: Record<string, unknown> | undefined,
  limits: FreeRunFileLimits
): Promise<{ ok: true; file: FreeRunFile | null } | { ok: false; refusal: FreeRunFileRefusal }> {
  if (body?.files !== undefined) return { ok: false, refusal: TOO_MANY_FILES };
  let raw = body?.file;
  if (raw === undefined || raw === null) return { ok: true, file: null };
  if (Array.isArray(raw)) {
    if (raw.length > 1) return { ok: false, refusal: TOO_MANY_FILES };
    if (raw.length === 0) return { ok: true, file: null };
    raw = raw[0];
  }
  const given = raw as { name?: unknown; type?: unknown; data?: unknown } | null;
  if (typeof given !== 'object' || given === null || typeof given.data !== 'string') {
    return { ok: false, refusal: MALFORMED };
  }
  const name = cleanName(typeof given.name === 'string' ? given.name : '');
  const declaredType = typeof given.type === 'string' ? given.type.toLowerCase() : '';
  const data = given.data;

  // Checked on the encoded length so an oversized file is refused without decoding it.
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = Math.floor((data.length * 3) / 4) - padding;
  if (size > limits.maxBytes) {
    return {
      ok: false,
      refusal: refusal('file_too_large', `Attach a file under ${formatFileCap(limits.maxBytes)}.`, 413),
    };
  }
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, refusal: MALFORMED };
  const bytes = Buffer.from(data, 'base64');

  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return readPdf(bytes, name, limits.maxPages);

  const image = IMAGE_SIGNATURES.find(signature => signature.test(bytes));
  if (image) return { ok: true, file: { kind: 'image', name, dataUrl: `data:${image.mediaType};base64,${data}` } };

  if (declaredType.startsWith('text/') || TEXT_NAME.test(name)) return readText(bytes, name);
  return { ok: false, refusal: UNSUPPORTED_TYPE };
}

function documentFile(name: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false as const, refusal: NO_TEXT };
  if (trimmed.length > FREE_RUN_FILE_TEXT_MAX_CHARS) return { ok: false as const, refusal: TOO_MUCH_TEXT };
  return { ok: true as const, file: { kind: 'document' as const, name, text: trimmed } };
}

function readText(bytes: Buffer, name: string) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false as const, refusal: UNSUPPORTED_TYPE };
  }
  if (text.includes('\u0000')) return { ok: false as const, refusal: UNSUPPORTED_TYPE };
  return documentFile(name, text);
}

async function readPdf(bytes: Buffer, name: string, maxPages: number) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy, not `bytes.buffer`: a small Buffer is a view into Node's shared allocation pool.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    return { ok: false as const, refusal: MALFORMED };
  }
  try {
    if (pdf.numPages > maxPages) {
      return {
        ok: false as const,
        refusal: refusal(
          'file_too_many_pages',
          `Attach a PDF of ${maxPages} page${maxPages === 1 ? '' : 's'} or fewer.`
        ),
      };
    }
    const { text } = await extractText(pdf, { mergePages: true });
    return documentFile(name, String(text));
  } catch {
    return { ok: false as const, refusal: MALFORMED };
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}
