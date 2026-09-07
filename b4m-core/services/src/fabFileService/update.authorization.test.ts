import { describe, it, expect, vi } from 'vitest';
import { IFabFileDocument, IUserDocument, Permission } from '@bike4mind/common';
import { updateFabFile } from './update';
import { createShareableFake } from '../__tests__/utils/shareableFake';

describe('updateFabFile authorization', () => {
  const OWNER = 'user-owner';
  const SHAREE = 'user-sharee';

  const sharedFile = (permissions: Permission[]) =>
    ({
      id: 'file-1',
      userId: OWNER,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      filePath: 'uploads/notes.txt',
      fileSize: 12,
      users: [{ userId: SHAREE, permissions }],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
    }) as unknown as IFabFileDocument;

  const adaptersFor = (file: IFabFileDocument) => {
    const storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed'),
      getMetadata: vi.fn().mockResolvedValue({ size: 999 }),
    };
    const update = vi.fn().mockResolvedValue(undefined);
    return {
      adapters: { db: { fabFiles: { shareable: createShareableFake([file as never]), update } }, storage },
      storage,
      update,
    };
  };

  it('refuses a read-only sharee overwriting the owner file content, and writes nothing', async () => {
    const file = sharedFile([Permission.read]);
    const { adapters, storage, update } = adaptersFor(file);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateFabFile({ id: SHAREE } as IUserDocument, { id: 'file-1', fileContent: 'pwned' }, adapters as any)
    ).rejects.toThrow();

    expect(storage.upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(file.fileSize).toBe(12);
  });

  it('still allows a sharee holding update to edit the file', async () => {
    const file = sharedFile([Permission.read, Permission.update]);
    const { adapters, update } = adaptersFor(file);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile({ id: SHAREE } as IUserDocument, { id: 'file-1', notes: 'ok' }, adapters as any);

    expect(update).toHaveBeenCalled();
  });
});
