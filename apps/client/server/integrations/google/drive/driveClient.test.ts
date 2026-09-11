import { describe, it, expect, vi, afterEach } from 'vitest';
import type { drive_v3 } from '@googleapis/drive';
import {
  listFolderChildren,
  getFolderAccess,
  isFolder,
  isValidDriveFolderId,
  withDriveRetry,
  FOLDER_MIME_TYPE,
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
