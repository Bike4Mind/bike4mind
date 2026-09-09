import { describe, it, expect, vi } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { walkFolder, fetchDriveFileContent } from './driveContent';
import { FOLDER_MIME_TYPE, isDriveRateLimitError } from './driveClient';

const folder = (id: string, name: string) => ({ id, name, mimeType: FOLDER_MIME_TYPE });
const file = (id: string, name: string, mimeType: string) => ({ id, name, mimeType });

// walkFolder drives listFolderChildren, which queries `'<id>' in parents`. This mock resolves
// children per folder id parsed out of that query, so we can model an arbitrary tree.
function mockTreeDrive(tree: Record<string, unknown[]>) {
  const list = vi.fn(async (params: { q: string }) => {
    const id = /'([^']+)' in parents/.exec(params.q)?.[1];
    return { data: { files: tree[id ?? ''] ?? [] } };
  });
  return { drive: { files: { list } } as unknown as drive_v3.Drive, list };
}

describe('walkFolder', () => {
  it('recurses subfolders and returns files with a relative path', async () => {
    const { drive } = mockTreeDrive({
      root: [file('a', 'a.txt', 'text/plain'), folder('sub', 'sub')],
      sub: [file('b', 'b.txt', 'text/plain')],
    });

    const files = await walkFolder(drive, 'root');
    expect(files.map(f => f.relativePath).sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('terminates on a cyclic folder graph (visited guard) and returns each file once', async () => {
    const { drive } = mockTreeDrive({
      root: [folder('loop', 'loop')],
      loop: [folder('loop', 'loop'), file('c', 'c.txt', 'text/plain')], // self-referential
    });

    const files = await walkFolder(drive, 'root');
    expect(files.map(f => f.relativePath)).toEqual(['loop/c.txt']);
  });
});

describe('fetchDriveFileContent', () => {
  const bufOf = (s: string) => new TextEncoder().encode(s).buffer;

  it('exports a Google Doc to plain text', async () => {
    const exportFn = vi.fn(async () => ({ data: bufOf('doc body') }));
    const drive = { files: { export: exportFn, get: vi.fn() } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('d', 'Doc', 'application/vnd.google-apps.document'));
    expect(res.ok).toBe(true);
    expect(exportFn).toHaveBeenCalledWith(
      { fileId: 'd', mimeType: SupportedFabFileMimeTypes.TXT_PLAIN },
      { responseType: 'arraybuffer' }
    );
    if (res.ok) expect(res.mimeType).toBe(SupportedFabFileMimeTypes.TXT_PLAIN);
  });

  it('exports a Google Sheet to xlsx', async () => {
    const exportFn = vi.fn(async () => ({ data: bufOf('sheet') }));
    const drive = { files: { export: exportFn, get: vi.fn() } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('s', 'Sheet', 'application/vnd.google-apps.spreadsheet'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mimeType).toBe(SupportedFabFileMimeTypes.XLSX);
  });

  it('skips a non-ingestible google-apps type (e.g. Form) without calling export/get', async () => {
    const exportFn = vi.fn();
    const getFn = vi.fn();
    const drive = { files: { export: exportFn, get: getFn } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('f', 'Form', 'application/vnd.google-apps.form'));
    expect(res).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(exportFn).not.toHaveBeenCalled();
    expect(getFn).not.toHaveBeenCalled();
  });

  it('downloads a supported native file via alt=media', async () => {
    const getFn = vi.fn(async () => ({ data: bufOf('hello') }));
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('n', 'notes.txt', 'text/plain'));
    expect(res.ok).toBe(true);
    expect(getFn).toHaveBeenCalledWith(
      { fileId: 'n', alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
  });

  it('skips an unsupported native type', async () => {
    const getFn = vi.fn();
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('x', 'installer.exe', 'application/x-msdownload'));
    expect(res).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(getFn).not.toHaveBeenCalled();
  });

  it('reports export_too_large when Drive rejects an oversized export', async () => {
    const exportFn = vi.fn(async () => {
      throw new Error('exportSizeLimitExceeded: This file is too large to be exported.');
    });
    const drive = { files: { export: exportFn, get: vi.fn() } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('big', 'Huge', 'application/vnd.google-apps.document'));
    expect(res).toMatchObject({ ok: false, reason: 'export_too_large' });
  });

  // The whole point of the separate reason: `error` is permanent to the caller, so a throttle
  // landing there drops the file from the lake and still finalizes the batch clean.
  it('reports rate_limited (not error) when Drive throttles a native download', async () => {
    const getFn = vi.fn(async () => {
      throw Object.assign(new Error('Rate Limit Exceeded'), {
        code: 429,
        response: { status: 429, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
      });
    });
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('n', 'notes.txt', 'text/plain'));
    expect(res).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('reports rate_limited for a 403 whose reason is a quota, not a permission denial', async () => {
    const exportFn = vi.fn(async () => {
      throw Object.assign(new Error('The user has exceeded their rate limit.'), {
        code: 403,
        response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
      });
    });
    const drive = { files: { export: exportFn, get: vi.fn() } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('d', 'Doc', 'application/vnd.google-apps.document'));
    expect(res).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('still reports a permanent error for a non-throttle failure', async () => {
    const getFn = vi.fn(async () => {
      throw Object.assign(new Error('File not found'), { code: 404, response: { status: 404 } });
    });
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const res = await fetchDriveFileContent(drive, file('n', 'notes.txt', 'text/plain'));
    expect(res).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('isDriveRateLimitError', () => {
  it.each([
    ['a numeric 429 code', { code: 429 }],
    ['a string 429 code (googleapis stringifies it in places)', { code: '429' }],
    ['a 429 only on the response', { response: { status: 429 } }],
    ['a 403 carrying userRateLimitExceeded', { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }],
    [
      'a nested quotaExceeded reason',
      { code: 403, response: { data: { error: { errors: [{ reason: 'quotaExceeded' }] } } } },
    ],
  ])('detects %s', (_label, shape) => {
    expect(isDriveRateLimitError(Object.assign(new Error('throttled'), shape))).toBe(true);
  });

  it.each([
    [
      'a permission denial, which shares the 403 but not the reason',
      { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] },
    ],
    ['an oversized export', { code: 403, errors: [{ reason: 'exportSizeLimitExceeded' }] }],
    ['a not-found', { code: 404 }],
    ['a DNS failure whose code is a non-numeric string', { code: 'ENOTFOUND' }],
    ['a plain error', {}],
  ])('does not treat %s as a rate limit', (_label, shape) => {
    expect(isDriveRateLimitError(Object.assign(new Error('nope'), shape))).toBe(false);
  });

  it('is safe on non-object rejections', () => {
    expect(isDriveRateLimitError(undefined)).toBe(false);
    expect(isDriveRateLimitError('429')).toBe(false);
  });
});
