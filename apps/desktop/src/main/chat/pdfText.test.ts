import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from './AttachmentStore';
import { PDF_INPUT_MAX, PDF_MAX_PAGES, TEXT_BYTE_CAP, looksLikePdf } from './attachments';
import { makePdf } from './pdfFixtures';
import { capPdfText, extractPdfText, preparePdf } from './pdfText';

const LONG_TEXT = `${'word '.repeat(40)}\n`.repeat(900);

async function storeIn(): Promise<{ store: AttachmentStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'b4m-pdf-'));
  return { store: new AttachmentStore(join(dir, 'a'), { debug: () => undefined, warn: () => undefined }), dir };
}

describe('looksLikePdf', () => {
  it('matches by extension, media type, or magic bytes alone', () => {
    expect(looksLikePdf('a.PDF', undefined, Buffer.from('x'))).toBe(true);
    expect(looksLikePdf('a', 'application/pdf', Buffer.from('x'))).toBe(true);
    expect(looksLikePdf('a', undefined, Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf('a.txt', 'text/plain', Buffer.from('hello'))).toBe(false);
  });
});

describe('extractPdfText', () => {
  it('reads the text and page count', async () => {
    const result = await extractPdfText(makePdf(['Hello quarterly report', 'Second page']));
    expect(result.pages).toBe(2);
    expect(result.text).toContain('Hello quarterly report');
    expect(result.text).toContain('Second page');
  });
});

describe('preparePdf', () => {
  it('keeps the original bytes and records the page count', async () => {
    const bytes = makePdf(['Invoice 42']);
    const result = await preparePdf('inv.pdf', bytes);
    expect(result).toMatchObject({
      ok: true,
      prepared: { kind: 'pdf', mediaType: 'application/pdf', pages: 1, sourceBytes: bytes.length },
    });
    if (result.ok) expect(result.prepared.bytes.equals(bytes)).toBe(true);
  });

  it('rejects an empty file', async () => {
    expect(await preparePdf('a.pdf', Buffer.alloc(0))).toEqual({ ok: false, reason: 'That file is empty.' });
  });

  it('rejects one over the size limit without parsing it', async () => {
    const result = await preparePdf('big.pdf', Buffer.alloc(PDF_INPUT_MAX + 1));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('the limit is 32.0 MB') });
  });

  it('rejects one over the page limit', async () => {
    const pages = Array.from({ length: PDF_MAX_PAGES + 1 }, (_, index) => `page ${index}`);
    const result = await preparePdf('long.pdf', makePdf(pages));
    expect(result).toEqual({
      ok: false,
      reason: `That PDF has ${PDF_MAX_PAGES + 1} pages; the limit is ${PDF_MAX_PAGES}.`,
    });
  });

  it('rejects a password-protected PDF', async () => {
    const result = await preparePdf('locked.pdf', makePdf(['secret'], { encrypted: true }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('password-protected') });
  });

  it('rejects something that is not a PDF', async () => {
    const result = await preparePdf('junk.pdf', Buffer.from('not a pdf at all'));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('could not be read') });
  });

  it('rejects a PDF with no text and suggests screenshots', async () => {
    const result = await preparePdf('scan.pdf', makePdf(['', '']));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Attach screenshots of the pages') });
  });

  it('flags a document whose text exceeds the cap', async () => {
    const result = await preparePdf('wide.pdf', makePdf([LONG_TEXT]));
    expect(result).toMatchObject({ ok: true, prepared: { truncated: true } });
  });
});

describe('capPdfText', () => {
  it('passes short text through and marks a long one as truncated', () => {
    expect(capPdfText('short')).toEqual({ text: 'short', truncated: false });
    const long = capPdfText(`${'line of text\n'.repeat(20000)}`);
    expect(long.truncated).toBe(true);
    expect(long.text).toContain('extracted text. The rest was not sent');
    expect(Buffer.byteLength(long.text)).toBeLessThan(TEXT_BYTE_CAP + 400);
  });
});

describe('AttachmentStore PDF intake', () => {
  it('detects a PDF by magic bytes when the name has no extension (bytes)', async () => {
    const { store } = await storeIn();
    const result = await store.add('s1', [
      { source: 'bytes', name: 'pasted', data: new Uint8Array(makePdf(['hi there'])) },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.attachments[0]).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', pages: 1 });
  });

  it('detects a PDF by magic bytes from a path without an extension', async () => {
    const { store, dir } = await storeIn();
    const path = join(dir, 'noext');
    await writeFile(path, makePdf(['from disk']));
    const result = await store.add('s1', [{ source: 'path', path }]);
    expect(result.attachments[0]).toMatchObject({ kind: 'pdf', name: 'noext' });
    expect((await store.read('s1', result.attachments[0].id))?.equals(await readFile(path))).toBe(true);
  });

  it('reports the rejection reason by name', async () => {
    const { store } = await storeIn();
    const result = await store.add('s1', [{ source: 'bytes', name: 'scan.pdf', data: new Uint8Array(makePdf([''])) }]);
    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ name: 'scan.pdf', reason: expect.stringContaining('scanned') });
  });

  it('counts toward the per-turn limit', async () => {
    const { store } = await storeIn();
    const pdf = new Uint8Array(makePdf(['x y z']));
    const inputs = Array.from({ length: 11 }, (_, index) => ({
      source: 'bytes' as const,
      name: `${index}.pdf`,
      data: pdf,
    }));
    const result = await store.add('s1', inputs);
    expect(result.attachments).toHaveLength(10);
    expect(result.rejected[0].reason).toContain('Only 10 attachments');
  });
});
