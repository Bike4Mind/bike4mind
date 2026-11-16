import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { updateDocumentSharing } from './updateDocumentSharing';

type Adapters = Parameters<typeof updateDocumentSharing>[2];

describe('sharingService - updateDocumentSharing', () => {
  const user = { id: 'user-1' } as any;

  const storage = { generateSignedUrl: vi.fn() };

  let db: {
    sessions: { shareable: { findShareAccessById: Mock }; update: Mock };
    fabFiles: { shareable: { findShareAccessById: Mock }; update: Mock };
    organizations: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storage.generateSignedUrl.mockResolvedValue('https://fresh.example.invalid/f1');
    db = {
      sessions: { shareable: { findShareAccessById: vi.fn() }, update: vi.fn() },
      fabFiles: { shareable: { findShareAccessById: vi.fn() }, update: vi.fn() },
      organizations: { findById: vi.fn() },
    };
  });

  it('updates a session and returns the re-read persisted flags', async () => {
    // pre-write read (auth), then the post-write re-read reflecting the persisted flags
    db.sessions.shareable.findShareAccessById
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: false, isGlobalWrite: false })
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: true, isGlobalWrite: false });

    const result = await updateDocumentSharing(
      user,
      { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: false },
      { db, storage } as any
    );

    // exact payload: only the two flags are written (never the whole doc)
    expect(db.sessions.update).toHaveBeenCalledWith({ id: 's1', isGlobalRead: true, isGlobalWrite: false });
    expect(result).toMatchObject({ isGlobalRead: true, isGlobalWrite: false });
    expect(result).not.toHaveProperty('fileUrl');
    expect(storage.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('falls back to the pre-write doc but still returns the written flags when the re-read races to null', async () => {
    // pre-write read (auth) returns the stale doc; the post-write re-read returns null
    db.sessions.shareable.findShareAccessById
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: false, isGlobalWrite: false })
      .mockResolvedValueOnce(null);

    const result: any = await updateDocumentSharing(
      user,
      { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: true },
      { db, storage } as any
    );

    // the param override wins over the stale fallback doc, so the response is accurate
    expect(result.isGlobalRead).toBe(true);
    expect(result.isGlobalWrite).toBe(true);
  });

  it('returns a freshly signed fileUrl for an image-serveable file', async () => {
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({
      id: 'f1',
      filePath: 'owned/f1.png',
      mimeType: 'image/png',
      moderationStatus: 'clean',
      fileUrl: 'https://signed',
      fileUrlExpireAt: 123,
    });

    const result: any = await updateDocumentSharing(
      user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: true },
      { db, storage } as any
    );

    expect(result.fileUrl).toBe('https://fresh.example.invalid/f1');
    expect(result.fileUrlExpireAt).toBeInstanceOf(Date);
    expect(storage.generateSignedUrl).toHaveBeenCalledWith('owned/f1.png', 3600, { signingDate: expect.any(Date) });
  });

  it('strips fileUrl from the response for a non-serveable file (targeted write never touches it)', async () => {
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({
      id: 'f1',
      mimeType: 'image/png',
      moderationStatus: 'pending',
      fileUrl: 'https://signed',
      fileUrlExpireAt: 123,
    });

    const result: any = await updateDocumentSharing(
      user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: true },
      { db, storage } as any
    );

    // response is stripped, and nothing is signed
    expect(result.fileUrl).toBeUndefined();
    expect(storage.generateSignedUrl).not.toHaveBeenCalled();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // the persisted write is targeted to the two flags only - it never carries fileUrl,
    // so the stored URL is left intact.
    const writeArg = db.fabFiles.update.mock.calls[0][0];
    expect(writeArg).toEqual({ id: 'f1', isGlobalRead: true, isGlobalWrite: true });
  });

  it('normalizes a hydrated (toJSON) doc and strips fileUrl for a non-serveable file', async () => {
    // a real repo returns a hydrated Mongoose doc with a toJSON() method - the plain-object
    // mocks above never exercise that branch, so drive it explicitly here.
    const hydrated = {
      toJSON: () => ({
        id: 'f1',
        mimeType: 'image/png',
        moderationStatus: 'blocked',
        fileUrl: 'https://signed',
        fileUrlExpireAt: 123,
      }),
    };
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(hydrated);

    const result: any = await updateDocumentSharing(
      user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: false },
      { db, storage } as any
    );

    // toJSON branch ran (flags applied to the normalized object) and the leak-gate stripped the URL
    expect(result.isGlobalRead).toBe(true);
    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
  });

  it('throws NotFoundError when the caller lacks share access', async () => {
    db.sessions.shareable.findShareAccessById.mockResolvedValue(null);
    await expect(
      updateDocumentSharing(user, { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: true }, {
        db,
      } as any)
    ).rejects.toThrow(NotFoundError);
    expect(db.sessions.update).not.toHaveBeenCalled();
  });

  describe('organization sharing policy', () => {
    const lockedOrg = {
      userId: 'owner',
      users: [],
      sharingPolicy: { allowPublicLinks: false, allowExternalSharing: true, allowedDomains: [] },
    };

    it('refuses making an org-bound file global when the org disallows public links', async () => {
      db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'f1', organizationId: 'org-1' });
      db.organizations.findById.mockResolvedValue(lockedOrg);

      await expect(
        updateDocumentSharing(user, { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: false }, {
          db,
          storage,
        } as unknown as Adapters)
      ).rejects.toThrow('public links');
      expect(db.organizations.findById).toHaveBeenCalledWith('org-1');
      expect(db.fabFiles.update).not.toHaveBeenCalled();
    });

    it('lets an org-bound file be turned private, or stay global, without a policy check', async () => {
      db.fabFiles.shareable.findShareAccessById.mockResolvedValue({
        id: 'f1',
        organizationId: 'org-1',
        isGlobalRead: true,
      });

      await updateDocumentSharing(user, { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: false }, {
        db,
        storage,
      } as unknown as Adapters);
      await updateDocumentSharing(user, { id: 'f1', type: 'files', isGlobalRead: false, isGlobalWrite: false }, {
        db,
        storage,
      } as unknown as Adapters);

      expect(db.organizations.findById).not.toHaveBeenCalled();
      expect(db.fabFiles.update).toHaveBeenCalledTimes(2);
    });

    it('makes a personal file global without consulting any organization', async () => {
      db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'f1' });

      await updateDocumentSharing(user, { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: true }, {
        db,
        storage,
      } as unknown as Adapters);

      expect(db.organizations.findById).not.toHaveBeenCalled();
      expect(db.fabFiles.update).toHaveBeenCalledWith({ id: 'f1', isGlobalRead: true, isGlobalWrite: true });
    });
  });
});
