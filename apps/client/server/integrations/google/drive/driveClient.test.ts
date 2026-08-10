import { describe, it, expect, vi } from 'vitest';
import type { drive_v3 } from 'googleapis';
import { listFolderChildren, isFolder, FOLDER_MIME_TYPE } from './driveClient';

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
});

describe('isFolder', () => {
  it('detects the Drive folder mime type', () => {
    expect(isFolder({ id: '1', name: 'sub', mimeType: FOLDER_MIME_TYPE })).toBe(true);
    expect(isFolder({ id: '2', name: 'a.txt', mimeType: 'text/plain' })).toBe(false);
  });
});
