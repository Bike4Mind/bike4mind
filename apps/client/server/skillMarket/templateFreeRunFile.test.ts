import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FREE_RUN_FILE_TEXT_MAX_CHARS,
  FREE_RUN_FILE_TRANSPORT_MAX_BYTES,
  freeRunFileMaxBytes,
  readFreeRunFile,
} from './templateFreeRunFile';
import { asUpload, makePdf, PNG_1PX } from './templateFreeRunFile.fixtures';

const LIMITS = { maxBytes: 1024 * 1024, maxPages: 3 };
const read = (file: unknown, limits = LIMITS) => readFreeRunFile({ file }, limits);

describe('readFreeRunFile', () => {
  it('returns no file when none is sent', async () => {
    await expect(readFreeRunFile({ text: 'x' }, LIMITS)).resolves.toEqual({ ok: true, file: null });
    await expect(read(null)).resolves.toEqual({ ok: true, file: null });
  });

  it('reads a PDF within the page cap as its text', async () => {
    const result = await read(asUpload(makePdf(['Alpha page', 'Beta page']), 'notes.pdf', 'application/pdf'));
    expect(result).toEqual({ ok: true, file: { kind: 'document', name: 'notes.pdf', text: expect.any(String) } });
    if (!result.ok || result.file?.kind !== 'document') throw new Error('expected a document');
    expect(result.file.text).toContain('Alpha page');
    expect(result.file.text).toContain('Beta page');
  });

  it('refuses a PDF over the page cap', async () => {
    const result = await read(asUpload(makePdf(['1', '2', '3', '4']), 'long.pdf', 'application/pdf'));
    expect(result).toEqual({
      ok: false,
      refusal: { status: 400, code: 'file_too_many_pages', error: 'Attach a PDF of 3 pages or fewer.' },
    });
  });

  it('refuses a file over the size cap before decoding it', async () => {
    const result = await read(asUpload(Buffer.alloc(2048, 0x61), 'big.txt', 'text/plain'), {
      maxBytes: 1024,
      maxPages: 3,
    });
    expect(result).toMatchObject({ ok: false, refusal: { status: 413, code: 'file_too_large' } });
  });

  it('sends an image by its sniffed type, whatever the declared one', async () => {
    const result = await read(asUpload(PNG_1PX, 'photo.jpg', 'image/jpeg'));
    expect(result).toEqual({
      ok: true,
      file: { kind: 'image', name: 'photo.jpg', dataUrl: `data:image/png;base64,${PNG_1PX.toString('base64')}` },
    });
  });

  it('reads a UTF-8 text file', async () => {
    const result = await read(asUpload(Buffer.from('  café notes \n'), 'a.md', ''));
    expect(result).toEqual({ ok: true, file: { kind: 'document', name: 'a.md', text: 'café notes' } });
  });

  it.each([
    ['a second file', { files: [{}, {}] }, 'too_many_files'],
    [
      'two files in one field',
      { file: [asUpload(PNG_1PX, 'a.png', ''), asUpload(PNG_1PX, 'b.png', '')] },
      'too_many_files',
    ],
    ['a malformed file', { file: { name: 'x', data: 'not base64!' } }, 'file_invalid'],
    ['a file without data', { file: { name: 'x' } }, 'file_invalid'],
    [
      'a binary file',
      { file: asUpload(Buffer.from([0, 1, 2, 3, 4, 5]), 'x.bin', 'application/zip') },
      'file_type_unsupported',
    ],
    [
      'a text file with NUL bytes',
      { file: asUpload(Buffer.from('a\u0000b'), 'x.txt', 'text/plain') },
      'file_type_unsupported',
    ],
    ['a text file that is blank', { file: asUpload(Buffer.from('  \n'), 'x.txt', 'text/plain') }, 'file_no_text'],
    [
      'a text file with too much text',
      { file: asUpload(Buffer.alloc(FREE_RUN_FILE_TEXT_MAX_CHARS + 1, 0x61), 'x.txt', 'text/plain') },
      'file_text_too_long',
    ],
    ['a corrupt PDF', { file: asUpload(Buffer.from('%PDF-1.4 garbage'), 'x.pdf', 'application/pdf') }, 'file_invalid'],
  ])('refuses %s', async (_label, body, code) => {
    await expect(readFreeRunFile(body, { maxBytes: 4 * 1024 * 1024, maxPages: 3 })).resolves.toMatchObject({
      ok: false,
      refusal: { code },
    });
  });

  it('strips control characters from the file name', async () => {
    const result = await read(asUpload(Buffer.from('hi'), 'a\nb\u0007.txt', 'text/plain'));
    expect(result).toMatchObject({ ok: true, file: { name: 'a b .txt' } });
  });
});

describe('freeRunFileMaxBytes', () => {
  it('turns the admin MB cap into bytes, never past the transport ceiling', () => {
    expect(freeRunFileMaxBytes(1)).toBe(1024 * 1024);
    expect(freeRunFileMaxBytes(0.5)).toBe(512 * 1024);
    expect(freeRunFileMaxBytes(5)).toBe(FREE_RUN_FILE_TRANSPORT_MAX_BYTES);
  });
});

describe('nothing is stored', () => {
  it('the file reader reaches no storage, S3 or database module', () => {
    const source = readFileSync(new URL('./templateFreeRunFile.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].map(m => m[1] ?? m[2]);
    expect(imports).toEqual(['unpdf']);
  });
});
