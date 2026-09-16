import { describe, it, expect, vi, afterEach } from 'vitest';
import type { drive_v3 } from '@googleapis/drive';
import {
  listFolderChildren,
  getFolderAccess,
  isFolder,
  isValidDriveFolderId,
  withDriveRetry,
  FOLDER_MIME_TYPE,
  listChanges,
  getStartPageToken,
  isDriveInvalidCursorError,
  getFileParents,
} from './driveClient';

/** The shape googleapis hands back for a throttle - a 429, or a 403 whose reason is a quota. */
const throttle = (status = 429, reason = 'userRateLimitExceeded') =>
  Object.assign(new Error('Rate Limit Exceeded'), {
    code: status,
    response: { status, data: { error: { errors: [{ reason }] } } },
  });

/**
 * The retry sleeps for real, so every test that drives one through a throttle runs on fake timers
 * and flushes them rather than waiting out the backoff.
 *
 * The outcome is captured as a thunk BEFORE the flush: an unattended rejection landing while the
 * timers run is reported as an unhandled error, even though the caller awaits it a line later.
 */
const settleThroughBackoff = async <T>(pending: Promise<T>): Promise<T> => {
  const settled = pending.then(
    value => () => value,
    (error: unknown) => () => {
      throw error;
    }
  );
  await vi.runAllTimersAsync();
  return settled.then(replay => replay());
};

/**
 * Mocks just the `files.list` surface listFolderChildren uses, returning a queue of pages so
 * pagination and the shared-drive flags can be asserted without hitting Google.
 */
function mockDrive(pages: Array<{ files?: unknown[]; nextPageToken?: string }>) {
  const list = vi.fn();
  for (const page of pages) list.mockResolvedValueOnce({ data: page });
  return { drive: { files: { list } } as unknown as drive_v3.Drive, list };
}

describe('listFolderChildren', () => {
  it('scopes the query to the folder and requests shared-drive items', async () => {
    const { drive, list } = mockDrive([{ files: [] }]);
    await listFolderChildren(drive, 'FOLDER_X');

    expect(list).toHaveBeenCalledTimes(1);
    const args = list.mock.calls[0][0];
    expect(args.q).toContain("'FOLDER_X' in parents");
    expect(args.q).toContain('trashed = false');
    expect(args.supportsAllDrives).toBe(true);
    expect(args.includeItemsFromAllDrives).toBe(true);
  });

  it('follows pagination and concatenates every page', async () => {
    const { drive, list } = mockDrive([
      { files: [{ id: '1', name: 'a.txt', mimeType: 'text/plain' }], nextPageToken: 'p2' },
      { files: [{ id: '2', name: 'b.txt', mimeType: 'text/plain' }] },
    ]);

    const files = await listFolderChildren(drive, 'FOLDER_X');

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].pageToken).toBe('p2');
    expect(files.map(f => f.id)).toEqual(['1', '2']);
  });

  it('skips entries missing id/name/mimeType', async () => {
    const { drive } = mockDrive([
      {
        files: [
          { id: '1', name: 'ok.txt', mimeType: 'text/plain' },
          { id: '2', name: 'no-mime' }, // dropped
          { name: 'no-id', mimeType: 'text/plain' }, // dropped
        ],
      },
    ]);

    const files = await listFolderChildren(drive, 'FOLDER_X');
    expect(files).toEqual([{ id: '1', name: 'ok.txt', mimeType: 'text/plain' }]);
  });

  it('throws on an invalid folder id before issuing any query (injection guard)', async () => {
    const { drive, list } = mockDrive([{ files: [] }]);
    await expect(listFolderChildren(drive, "x' in parents or '1'='1")).rejects.toThrow(/Invalid Drive folder id/);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('isValidDriveFolderId', () => {
  it('accepts real Drive ids and the root alias', () => {
    expect(isValidDriveFolderId('1_BPIetEv-aLXcWp5Tvhc0miCMA2Hwc11')).toBe(true);
    expect(isValidDriveFolderId('root')).toBe(true);
  });

  it('rejects ids with quotes, spaces, or empty/non-string input', () => {
    expect(isValidDriveFolderId("x' in parents")).toBe(false);
    expect(isValidDriveFolderId('has space')).toBe(false);
    expect(isValidDriveFolderId('')).toBe(false);
    expect(isValidDriveFolderId(undefined)).toBe(false);
  });
});

describe('getFolderAccess', () => {
  const driveWithGet = (impl: () => unknown) => ({ files: { get: vi.fn(impl) } }) as unknown as drive_v3.Drive;

  it('reports a readable folder the caller can see', async () => {
    const drive = driveWithGet(async () => ({
      data: { id: 'F', mimeType: FOLDER_MIME_TYPE, capabilities: { canDownload: true } },
    }));
    expect(await getFolderAccess(drive, 'FOLDER_X')).toEqual({ ok: true, exists: true, isFolder: true, canRead: true });
  });

  it('treats a Drive error (404 for an inaccessible folder) as not-exists, failing closed', async () => {
    const drive = driveWithGet(async () => {
      throw new Error('File not found');
    });
    expect(await getFolderAccess(drive, 'FOLDER_X')).toEqual({
      ok: true,
      exists: false,
      isFolder: false,
      canRead: false,
    });
  });

  it('flags a readable id that is a file, not a folder', async () => {
    const drive = driveWithGet(async () => ({ data: { id: 'F', mimeType: 'text/plain' } }));
    expect(await getFolderAccess(drive, 'FOLDER_X')).toMatchObject({ exists: true, isFolder: false });
  });

  it('denies read only on an explicit canDownload:false', async () => {
    const drive = driveWithGet(async () => ({
      data: { id: 'F', mimeType: FOLDER_MIME_TYPE, capabilities: { canDownload: false } },
    }));
    expect(await getFolderAccess(drive, 'FOLDER_X')).toMatchObject({ canRead: false });
  });

  it('never issues a query for an invalid id', async () => {
    const get = vi.fn();
    const drive = { files: { get } } as unknown as drive_v3.Drive;
    expect(await getFolderAccess(drive, "x' in parents")).toEqual({
      ok: true,
      exists: false,
      isFolder: false,
      canRead: false,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('isFolder', () => {
  it('detects the Drive folder mime type', () => {
    expect(isFolder({ id: '1', name: 'sub', mimeType: FOLDER_MIME_TYPE })).toBe(true);
    expect(isFolder({ id: '2', name: 'a.txt', mimeType: 'text/plain' })).toBe(false);
  });
});

describe('withDriveRetry', () => {
  afterEach(() => vi.useRealTimers());

  it('retries a throttled call and returns the value once Drive lets it through', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(throttle()).mockResolvedValue('listed');

    await expect(settleThroughBackoff(withDriveRetry('files.list', call))).resolves.toBe('listed');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('retries a 403 whose reason is a quota, not a permission denial', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(throttle(403, 'rateLimitExceeded')).mockResolvedValue('listed');

    await expect(settleThroughBackoff(withDriveRetry('files.list', call))).resolves.toBe('listed');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rethrows the ORIGINAL error when the throttle outlives the budget, so callers can still detect it', async () => {
    vi.useFakeTimers();
    const err = throttle();
    const call = vi.fn().mockRejectedValue(err);

    // Identity matters: the caller sheds load by re-testing this error with isDriveRateLimitError,
    // which a wrapper error would defeat.
    await expect(settleThroughBackoff(withDriveRetry('files.list', call))).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(4); // the attempt plus DRIVE_RETRY_MAX_RETRIES
  });

  it('does not retry a permanent failure', async () => {
    const call = vi.fn().mockRejectedValue(Object.assign(new Error('File not found'), { code: 404 }));

    await expect(withDriveRetry('files.get', call)).rejects.toThrow('File not found');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx, which createDriveClient no longer lets googleapis retry for us', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Backend Error'), { code: 503, response: { status: 503 } }))
      .mockResolvedValue('listed');

    await expect(settleThroughBackoff(withDriveRetry('files.list', call))).resolves.toBe('listed');
    expect(call).toHaveBeenCalledTimes(2);
  });

  // gaxios' disabled retry layer also covered failures with NO HTTP response at all (a dropped
  // connection, a DNS miss, a timed-out socket) via its own noResponseRetries - this has to too, now
  // that it is the only layer left.
  it('retries a network-level failure with no HTTP response (ECONNRESET, ETIMEDOUT, ...)', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValue('listed');

    await expect(settleThroughBackoff(withDriveRetry('files.list', call))).resolves.toBe('listed');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure that merely lacks a numeric code', async () => {
    // A response IS present here (unlike the network-failure case above), so this must stay a
    // permanent failure - retrying anything without a response would swallow ordinary bugs too.
    const call = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('boom'), { code: 'SOME_APP_ERROR', response: { status: 400 } }));

    await expect(withDriveRetry('files.get', call)).rejects.toThrow('boom');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('createDriveClient', () => {
  it('turns googleapis own retry layer off, so withDriveRetry is the only one', async () => {
    // Two layers compose multiplicatively (~16 HTTP attempts per call) and googleapis backs off
    // without jitter, which is what re-collides connections sharing one Drive project quota.
    const { createDriveClient: create } = await import('./driveClient');
    const client = create('token') as unknown as { context: { _options: { retry?: boolean } } };
    expect(client.context._options.retry).toBe(false);
  });
});

describe('rate limits', () => {
  afterEach(() => vi.useRealTimers());

  it('listFolderChildren retries a throttled page rather than failing the walk', async () => {
    vi.useFakeTimers();
    const list = vi
      .fn()
      .mockRejectedValueOnce(throttle())
      .mockResolvedValue({ data: { files: [{ id: '1', name: 'a.txt', mimeType: 'text/plain' }] } });
    const drive = { files: { list } } as unknown as drive_v3.Drive;

    const files = await settleThroughBackoff(listFolderChildren(drive, 'FOLDER_X'));
    expect(files.map(f => f.id)).toEqual(['1']);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('getFolderAccess reports a sustained throttle as rate_limited, NOT as a missing folder', async () => {
    // The bug: `exists: false` here told a user they had lost access to a folder they own, and sent
    // them hunting a Drive permission problem that did not exist.
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValue(throttle());
    const drive = { files: { get } } as unknown as drive_v3.Drive;

    const access = await settleThroughBackoff(getFolderAccess(drive, 'FOLDER_X'));
    expect(access).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
});

describe('getStartPageToken', () => {
  it('returns the baseline cursor', async () => {
    const drive = { changes: { getStartPageToken: vi.fn(async () => ({ data: { startPageToken: 'p1' } })) } };
    expect(await getStartPageToken(drive as unknown as drive_v3.Drive)).toBe('p1');
  });

  it('throws if Drive omits the token (never silently returns an unusable cursor)', async () => {
    const drive = { changes: { getStartPageToken: vi.fn(async () => ({ data: {} })) } };
    await expect(getStartPageToken(drive as unknown as drive_v3.Drive)).rejects.toThrow(/did not return/);
  });
});

describe('listChanges', () => {
  function mockChangesDrive(pages: Array<{ changes?: unknown[]; nextPageToken?: string; newStartPageToken?: string }>) {
    const list = vi.fn();
    for (const page of pages) list.mockResolvedValueOnce({ data: page });
    return { drive: { changes: { list } } as unknown as drive_v3.Drive, list };
  }

  it('scopes the request to the given pageToken and requests shared-drive items', async () => {
    const { drive, list } = mockChangesDrive([{ changes: [], newStartPageToken: 'p2' }]);
    await listChanges(drive, 'p1');

    const args = list.mock.calls[0][0];
    expect(args.pageToken).toBe('p1');
    expect(args.supportsAllDrives).toBe(true);
    expect(args.includeItemsFromAllDrives).toBe(true);
  });

  it('follows pagination, concatenating changes, and returns the LAST page newStartPageToken', async () => {
    const { drive, list } = mockChangesDrive([
      {
        changes: [{ fileId: '1', removed: false, file: { id: '1', name: 'a.txt', mimeType: 'text/plain' } }],
        nextPageToken: 'p2',
      },
      { changes: [{ fileId: '2', removed: true }], newStartPageToken: 'p3' },
    ]);

    const { changes, newStartPageToken } = await listChanges(drive, 'p1');

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].pageToken).toBe('p2');
    expect(changes.map(c => c.fileId)).toEqual(['1', '2']);
    expect(newStartPageToken).toBe('p3');
  });

  it('carries removed/trashed/parents through for the caller to classify', async () => {
    const { drive } = mockChangesDrive([
      {
        changes: [
          {
            fileId: '1',
            removed: false,
            file: { id: '1', name: 'a.txt', mimeType: 'text/plain', parents: ['ROOT'], trashed: true },
          },
        ],
        newStartPageToken: 'p2',
      },
    ]);

    const { changes } = await listChanges(drive, 'p1');
    expect(changes).toEqual([
      {
        fileId: '1',
        removed: false,
        file: { id: '1', name: 'a.txt', mimeType: 'text/plain', parents: ['ROOT'], trashed: true },
      },
    ]);
  });

  it('represents a genuine removal with no `file`', async () => {
    const { drive } = mockChangesDrive([{ changes: [{ fileId: '1', removed: true }], newStartPageToken: 'p2' }]);
    const { changes } = await listChanges(drive, 'p1');
    expect(changes).toEqual([{ fileId: '1', removed: true, file: undefined }]);
  });

  it('throws if the last page never carries a newStartPageToken (would advance the cursor nowhere)', async () => {
    const { drive } = mockChangesDrive([{ changes: [] }]);
    await expect(listChanges(drive, 'p1')).rejects.toThrow(/newStartPageToken/);
  });
});

describe('isDriveInvalidCursorError', () => {
  it.each([
    ['a 400 (bad/malformed pageToken)', { code: 400 }],
    ['a 404 (pageToken no longer resolvable)', { response: { status: 404 } }],
  ])('detects %s', (_label, shape) => {
    expect(isDriveInvalidCursorError(Object.assign(new Error('bad token'), shape))).toBe(true);
  });

  it.each([
    ['a 429 (rate limit, not an invalid cursor)', { code: 429 }],
    ['a plain error', {}],
  ])('does not treat %s as an invalid cursor', (_label, shape) => {
    expect(isDriveInvalidCursorError(Object.assign(new Error('nope'), shape))).toBe(false);
  });

  it('is safe on non-object rejections', () => {
    expect(isDriveInvalidCursorError(undefined)).toBe(false);
  });
});

describe('getFileParents', () => {
  it('returns the current parent ids', async () => {
    const drive = { files: { get: vi.fn(async () => ({ data: { parents: ['P1', 'P2'] } })) } };
    expect(await getFileParents(drive as unknown as drive_v3.Drive, 'F')).toEqual(['P1', 'P2']);
  });

  it('returns null for a trashed file (not a usable ancestor)', async () => {
    const drive = { files: { get: vi.fn(async () => ({ data: { trashed: true, parents: ['P1'] } })) } };
    expect(await getFileParents(drive as unknown as drive_v3.Drive, 'F')).toBeNull();
  });

  it('returns null on a CONFIRMED 404 (the file is genuinely gone)', async () => {
    const drive = {
      files: {
        get: vi.fn(async () => {
          throw Object.assign(new Error('not found'), { code: 404 });
        }),
      },
    };
    expect(await getFileParents(drive as unknown as drive_v3.Drive, 'F')).toBeNull();
  });

  // Rethrown, not swallowed into null: null also means "confirmed gone", and isUnderRoot's caller
  // reads that as "moved out of the tree" for an already-tracked file - misreading a rate
  // limit/5xx/network blip the same way would silently evict a still-live file from the lake.
  it('rethrows a TRANSIENT failure rather than treating it as a confirmed not-found', async () => {
    const drive = {
      files: {
        get: vi.fn(async () => {
          throw new Error('rate limited');
        }),
      },
    };
    await expect(getFileParents(drive as unknown as drive_v3.Drive, 'F')).rejects.toThrow('rate limited');
  });
});
