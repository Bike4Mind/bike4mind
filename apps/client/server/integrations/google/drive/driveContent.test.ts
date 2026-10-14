import { describe, it, expect, vi, afterEach } from 'vitest';
import type { drive_v3 } from '@googleapis/drive';
import { DocumentDateSource, SupportedFabFileMimeTypes } from '@bike4mind/common';
import {
  walkFolder,
  fetchDriveFileContent,
  isUnderRoot,
  driveDocumentVintage,
  DriveWalkTimeBudgetExceededError,
  estimateFolder,
  driveIngestMimeType,
} from './driveContent';
import { MAX_INGEST_CANDIDATES, MAX_INGEST_FILE_BYTES } from './driveIngestLimits';
import { FOLDER_MIME_TYPE, MAX_LIST_PAGES, isDriveRateLimitError } from './driveClient';

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

  it('does not check the time budget when no remainingMs is given', async () => {
    const { drive } = mockTreeDrive({ root: [file('a', 'a.txt', 'text/plain')] });
    await expect(walkFolder(drive, 'root')).resolves.toEqual([
      { id: 'a', name: 'a.txt', mimeType: 'text/plain', relativePath: 'a.txt' },
    ]);
  });

  it('throws DriveWalkTimeBudgetExceededError before listing another folder once the budget runs low', async () => {
    // Two folders deep so the guard has a second folder to trip on before ever reaching it.
    const { drive, list } = mockTreeDrive({
      root: [folder('sub', 'sub')],
      sub: [file('b', 'b.txt', 'text/plain')],
    });
    // Plenty of time for the root listing, then below the buffer for the next one.
    const remainingMs = vi.fn().mockReturnValueOnce(120_000).mockReturnValue(1_000);

    await expect(walkFolder(drive, 'root', remainingMs)).rejects.toBeInstanceOf(DriveWalkTimeBudgetExceededError);
    expect(list).toHaveBeenCalledTimes(1); // root only - never reached 'sub'
  });

  it('never starts the walk at all if the budget is already spent', async () => {
    const { drive, list } = mockTreeDrive({ root: [file('a', 'a.txt', 'text/plain')] });
    const remainingMs = () => 1_000;

    await expect(walkFolder(drive, 'root', remainingMs)).rejects.toBeInstanceOf(DriveWalkTimeBudgetExceededError);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('fetchDriveFileContent', () => {
  // Several cases drive the in-process throttle retry, which sleeps for real.
  afterEach(() => vi.useRealTimers());

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
    vi.useFakeTimers();
    const getFn = vi.fn(async () => {
      throw Object.assign(new Error('Rate Limit Exceeded'), {
        code: 429,
        response: { status: 429, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
      });
    });
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const pending = fetchDriveFileContent(drive, file('n', 'notes.txt', 'text/plain'));
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: false, reason: 'rate_limited' });
    // Only a throttle that outlives the in-process retries reaches the caller as rate_limited.
    expect(getFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('retries a throttled download in-process and succeeds without ever reporting rate_limited', async () => {
    vi.useFakeTimers();
    const getFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate Limit Exceeded'), { code: 429, response: { status: 429 } }))
      .mockResolvedValue({ data: new TextEncoder().encode('hi').buffer });
    const drive = { files: { export: vi.fn(), get: getFn } } as unknown as drive_v3.Drive;

    const pending = fetchDriveFileContent(drive, file('n', 'notes.txt', 'text/plain'));
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: true, mimeType: 'text/plain' });
    expect(getFn).toHaveBeenCalledTimes(2);
  });

  it('reports rate_limited for a 403 whose reason is a quota, not a permission denial', async () => {
    vi.useFakeTimers();
    const exportFn = vi.fn(async () => {
      throw Object.assign(new Error('The user has exceeded their rate limit.'), {
        code: 403,
        response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
      });
    });
    const drive = { files: { export: exportFn, get: vi.fn() } } as unknown as drive_v3.Drive;

    const pending = fetchDriveFileContent(drive, file('d', 'Doc', 'application/vnd.google-apps.document'));
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: false, reason: 'rate_limited' });
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

describe('isUnderRoot', () => {
  /** A drive whose files.get resolves id -> parents per the given map (trashed/missing -> null). */
  function mockAncestryDrive(parentsOf: Record<string, string[] | 'trashed' | undefined>) {
    const get = vi.fn(async ({ fileId }: { fileId: string }) => {
      const entry = parentsOf[fileId];
      if (entry === 'trashed') return { data: { trashed: true } };
      return { data: { parents: entry } };
    });
    return { drive: { files: { get } } as unknown as drive_v3.Drive, get };
  }

  it('resolves true when a direct parent IS the root', async () => {
    const { drive } = mockAncestryDrive({});
    expect(await isUnderRoot(drive, ['ROOT'], 'ROOT', new Map())).toBe(true);
  });

  it('resolves true through several levels of ancestry', async () => {
    const { drive } = mockAncestryDrive({ mid: ['ROOT'], near: ['mid'] });
    expect(await isUnderRoot(drive, ['near'], 'ROOT', new Map())).toBe(true);
  });

  it('resolves false once the chain runs out before reaching the root', async () => {
    const { drive } = mockAncestryDrive({ top: [] });
    expect(await isUnderRoot(drive, ['top'], 'ROOT', new Map())).toBe(false);
  });

  it('resolves false (not throws) through a cyclic parents graph', async () => {
    const { drive } = mockAncestryDrive({ a: ['b'], b: ['a'] });
    expect(await isUnderRoot(drive, ['a'], 'ROOT', new Map())).toBe(false);
  });

  it('resolves false when an ancestor is trashed (not a usable chain)', async () => {
    const { drive } = mockAncestryDrive({ mid: 'trashed' });
    expect(await isUnderRoot(drive, ['mid'], 'ROOT', new Map())).toBe(false);
  });

  it('memoizes ancestor lookups across calls sharing one cache', async () => {
    const { drive, get } = mockAncestryDrive({ shared: ['ROOT'] });
    const cache = new Map<string, string[] | null>();
    await isUnderRoot(drive, ['shared'], 'ROOT', cache);
    await isUnderRoot(drive, ['shared'], 'ROOT', cache);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resolves false with no parents to check', async () => {
    const { drive } = mockAncestryDrive({});
    expect(await isUnderRoot(drive, undefined, 'ROOT', new Map())).toBe(false);
    expect(await isUnderRoot(drive, [], 'ROOT', new Map())).toBe(false);
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

describe('driveDocumentVintage', () => {
  const GOOGLE_DOC = 'application/vnd.google-apps.document';
  const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
  const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

  const driveFile = (mimeType: string, createdTime?: string) => ({
    id: 'f1',
    name: 'doc',
    mimeType,
    ...(createdTime ? { createdTime } : {}),
  });

  it.each([GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES])('takes createdTime for the Editors type %s', mimeType => {
    expect(driveDocumentVintage(driveFile(mimeType, '2019-03-04T09:15:00.000Z'))).toEqual({
      documentDate: new Date('2019-03-04T09:15:00.000Z'),
      documentDateSource: DocumentDateSource.DRIVE_CREATED,
    });
  });

  // The whole point of the Editors gate: for an uploaded binary, createdTime is when it was
  // uploaded to Drive, which is the ingestion-time-as-document-date mistake #3047 removed.
  it.each(['application/pdf', 'text/plain', SupportedFabFileMimeTypes.DOCX])(
    'refuses createdTime for the uploaded binary %s',
    mimeType => {
      expect(driveDocumentVintage(driveFile(mimeType, '2019-03-04T09:15:00.000Z'))).toEqual({});
    }
  );

  it('returns nothing when Drive offered no createdTime', () => {
    expect(driveDocumentVintage(driveFile(GOOGLE_DOC))).toEqual({});
  });

  it('applies the shared plausibility window rather than trusting Drive directly', () => {
    expect(driveDocumentVintage(driveFile(GOOGLE_DOC, '1970-01-01T00:00:00.000Z'))).toEqual({});
    expect(driveDocumentVintage(driveFile(GOOGLE_DOC, 'not-a-timestamp'))).toEqual({});
  });

  // The Editors gate reads EDITOR_EXPORTS with Object.hasOwn, so an inherited Object key must not
  // read as an authored type and pick up a vintage it has no claim to.
  it.each(['constructor', 'toString'])('refuses the inherited Object property %s as a mime type', mimeType => {
    expect(driveDocumentVintage(driveFile(mimeType, '2019-03-04T09:15:00.000Z'))).toEqual({});
  });
});

describe('driveIngestMimeType', () => {
  it.each([
    ['a Google Doc as its export target', file('d', 'Doc', 'application/vnd.google-apps.document'), 'text/plain'],
    ['a supported native file', file('n', 'n.txt', 'text/plain'), 'text/plain'],
    ['a Google Form as unsupported', file('f', 'Form', 'application/vnd.google-apps.form'), null],
    ['an unsupported native file', file('x', 'setup.exe', 'application/x-msdownload'), null],
  ])('resolves %s', (_label, f, expected) => {
    expect(driveIngestMimeType(f)).toBe(expected);
  });
});

describe('estimateFolder', () => {
  afterEach(() => vi.useRealTimers());

  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const opts = (over: Partial<Parameters<typeof estimateFolder>[2]> = {}) => ({
    deadlineMs: Date.now() + 60_000,
    maxFolders: 2000,
    maxFileSize: MAX_FILE_SIZE,
    ...over,
  });
  const sized = (id: string, name: string, mimeType: string, size: number) => ({ id, name, mimeType, size });

  it('walks nested folders through a cycle, counts a multi-parented file once, and classifies like the worker', async () => {
    const { drive } = mockTreeDrive({
      root: [
        sized('a', 'a.txt', 'text/plain', 100),
        file('doc', 'Doc', 'application/vnd.google-apps.document'),
        folder('sub', 'sub'),
      ],
      sub: [
        sized('a', 'a.txt', 'text/plain', 100), // same file, second parent
        folder('root', 'root'), // cycle back to the root
        file('nosize', 'n.txt', 'text/plain'),
        sized('atmax', 'max.txt', 'text/plain', MAX_FILE_SIZE), // >= MaxFileSize is skipped
        sized('justunder', 'under.txt', 'text/plain', MAX_FILE_SIZE - 1),
        file('form', 'Form', 'application/vnd.google-apps.form'),
        sized('exe', 'setup.exe', 'application/x-msdownload', 5),
      ],
    });

    expect(await estimateFolder(drive, 'root', opts())).toEqual({
      fileCount: 7,
      knownBytes: 100 + MAX_FILE_SIZE - 1,
      unknownSizeCount: 2,
      overSizeLimitCount: 1,
      unsupportedCount: 2,
      truncated: false,
      overCandidateCap: false,
    });
  });

  it('counts a file over the 50 MiB ingest cap as over-size even when MaxFileSize is higher, and before its type', async () => {
    const { drive } = mockTreeDrive({
      root: [sized('big', 'big.exe', 'application/x-msdownload', MAX_INGEST_FILE_BYTES + 1)],
    });
    const e = await estimateFolder(drive, 'root', opts({ maxFileSize: 10 * MAX_INGEST_FILE_BYTES }));
    expect(e).toMatchObject({ overSizeLimitCount: 1, unsupportedCount: 0, knownBytes: 0 });
  });

  it('flags a tree over the candidate cap and stops walking', async () => {
    const many = Array.from({ length: MAX_INGEST_CANDIDATES + 1 }, (_, i) => file(`f${i}`, `${i}.txt`, 'text/plain'));
    const { drive, list } = mockTreeDrive({ root: [...many, folder('sub', 'sub')], sub: [] });
    const e = await estimateFolder(drive, 'root', opts());
    expect(e).toMatchObject({ truncated: true, truncatedReason: 'candidate_cap', overCandidateCap: true });
    expect(list).toHaveBeenCalledTimes(1);
  });

  // A page counts every child (subfolders too), so a page count says nothing about the file count the
  // worker gates on: many small pages below the candidate cap must not block.
  it('does not flag a folder with many pages but fewer files than the candidate cap', async () => {
    const pages = Math.ceil(MAX_INGEST_CANDIDATES / 1000) + 5;
    let page = 0;
    const list = vi.fn(async () => {
      page++;
      return {
        data: {
          files: [file(`f${page}`, `${page}.txt`, 'text/plain')],
          nextPageToken: page < pages ? 'more' : undefined,
        },
      };
    });
    const drive = { files: { list } } as unknown as drive_v3.Drive;
    const e = await estimateFolder(drive, 'root', opts());
    expect(e).toMatchObject({ fileCount: pages, truncated: false, overCandidateCap: false });
    expect(list).toHaveBeenCalledTimes(pages);
  });

  // One folder too big to list is one the worker's walk also gives up on, so the estimate blocks it
  // rather than letting the lake be created for a sync that cannot run.
  it('blocks on a folder past the listing page cap', async () => {
    const list = vi.fn(async () => ({ data: { files: [file('x', 'x.txt', 'text/plain')], nextPageToken: 'more' } }));
    const drive = { files: { list } } as unknown as drive_v3.Drive;
    const e = await estimateFolder(drive, 'root', opts());
    expect(e).toMatchObject({ truncated: true, truncatedReason: 'page_cap', overCandidateCap: true });
    expect(list).toHaveBeenCalledTimes(MAX_LIST_PAGES);
  });

  it('returns a truncated partial result past the deadline instead of throwing', async () => {
    const { drive, list } = mockTreeDrive({ root: [file('a', 'a.txt', 'text/plain')] });
    const e = await estimateFolder(drive, 'root', opts({ deadlineMs: Date.now() - 1 }));
    expect(e).toMatchObject({ truncated: true, truncatedReason: 'deadline', fileCount: 0 });
    expect(list).not.toHaveBeenCalled();
  });

  it('stops at maxFolders with what it has so far', async () => {
    const { drive } = mockTreeDrive({
      root: [sized('a', 'a.txt', 'text/plain', 7), folder('sub', 'sub')],
      sub: [sized('b', 'b.txt', 'text/plain', 9)],
    });
    const e = await estimateFolder(drive, 'root', opts({ maxFolders: 1 }));
    expect(e).toMatchObject({ truncated: true, truncatedReason: 'folder_cap', fileCount: 1, knownBytes: 7 });
  });

  it('returns truncated rate_limited when a listing stays throttled past the retries', async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => {
      throw Object.assign(new Error('Rate Limit Exceeded'), {
        code: 429,
        response: { status: 429, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
      });
    });
    const drive = { files: { list } } as unknown as drive_v3.Drive;
    const pending = estimateFolder(drive, 'root', opts());
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ truncated: true, truncatedReason: 'rate_limited' });
  });

  it('rethrows any other Drive error', async () => {
    const list = vi.fn(async () => {
      throw Object.assign(new Error('Invalid Credentials'), { code: 401, response: { status: 401 } });
    });
    const drive = { files: { list } } as unknown as drive_v3.Drive;
    await expect(estimateFolder(drive, 'root', opts())).rejects.toThrow(/Invalid Credentials/);
  });
});
