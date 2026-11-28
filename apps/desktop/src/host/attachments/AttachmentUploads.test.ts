import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentUploads, type UploadStore } from './AttachmentUploads';

describe('AttachmentUploads', () => {
  let root: string;
  let staging: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'host-uploads-'));
    staging = join(root, '.uploads');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const uploadsIn = (directory: string) => {
    const store: UploadStore = {
      stagingDirectory: directory,
      addStaged: vi.fn(),
      isDiscardedDraft: () => false,
    };
    return new AttachmentUploads(store, { logger: { warn: vi.fn() } });
  };

  it('keeps no upload a connection began and closed before the begin finished', async () => {
    const uploads = uploadsIn(staging);
    const connection = {};
    const begun = uploads.begin(connection, { sessionId: 'session-1', name: 'a.txt', byteSize: 4 });
    await uploads.abortOwner(connection);

    await expect(begun).rejects.toMatchObject({ data: { reason: 'unknownUpload' } });
    expect(await readdir(staging)).toEqual([]);
  });

  it('keeps no upload begun as it is disposed', async () => {
    const uploads = uploadsIn(staging);
    const begun = uploads.begin({}, { sessionId: 'session-1', name: 'a.txt', byteSize: 4 });
    await uploads.dispose();

    await expect(begun).rejects.toMatchObject({ data: { reason: 'unknownUpload' } });
    expect(await readdir(staging)).toEqual([]);
  });
});
