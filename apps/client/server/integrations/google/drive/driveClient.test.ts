import { describe, it, expect, vi } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { listFolderChildren, getFolderAccess, isFolder, isValidDriveFolderId, FOLDER_MIME_TYPE } from './driveClient';

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
    expect(await getFolderAccess(drive, 'FOLDER_X')).toEqual({ exists: true, isFolder: true, canRead: true });
  });

  it('treats a Drive error (404 for an inaccessible folder) as not-exists, failing closed', async () => {
    const drive = driveWithGet(async () => {
      throw new Error('File not found');
    });
    expect(await getFolderAccess(drive, 'FOLDER_X')).toEqual({ exists: false, isFolder: false, canRead: false });
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
    expect(await getFolderAccess(drive, "x' in parents")).toEqual({ exists: false, isFolder: false, canRead: false });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('isFolder', () => {
  it('detects the Drive folder mime type', () => {
    expect(isFolder({ id: '1', name: 'sub', mimeType: FOLDER_MIME_TYPE })).toBe(true);
    expect(isFolder({ id: '2', name: 'a.txt', mimeType: 'text/plain' })).toBe(false);
  });
});
