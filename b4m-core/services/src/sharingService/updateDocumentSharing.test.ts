import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { updateDocumentSharing } from './updateDocumentSharing';

describe('sharingService - updateDocumentSharing', () => {
  const user = { id: 'user-1' } as any;

  let db: {
    sessions: { shareable: { findUpdateAccessById: Mock }; update: Mock };
    fabFiles: { shareable: { findUpdateAccessById: Mock }; update: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      sessions: { shareable: { findUpdateAccessById: vi.fn() }, update: vi.fn() },
      fabFiles: { shareable: { findUpdateAccessById: vi.fn() }, update: vi.fn() },
    };
  });

  it('updates a session and returns the re-read persisted flags', async () => {
    // pre-write read (auth), then the post-write re-read reflecting the persisted flags
    db.sessions.shareable.findUpdateAccessById
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: false, isGlobalWrite: false })
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: true, isGlobalWrite: false });

    const result = await updateDocumentSharing(
      user,
      { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: false },
      { db } as any
    );

    // exact payload: only the two flags are written (never the whole doc)
    expect(db.sessions.update).toHaveBeenCalledWith({ id: 's1', isGlobalRead: true, isGlobalWrite: false });
    expect(result).toMatchObject({ isGlobalRead: true, isGlobalWrite: false });
  });

  it('falls back to the pre-write doc but still returns the written flags when the re-read races to null', async () => {
    // pre-write read (auth) returns the stale doc; the post-write re-read returns null
    db.sessions.shareable.findUpdateAccessById
      .mockResolvedValueOnce({ id: 's1', isGlobalRead: false, isGlobalWrite: false })
      .mockResolvedValueOnce(null);

    const result: any = await updateDocumentSharing(
      user,
      { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: true },
      { db } as any
    );

    // the param override wins over the stale fallback doc, so the response is accurate
    expect(result.isGlobalRead).toBe(true);
    expect(result.isGlobalWrite).toBe(true);
  });

  it('keeps fileUrl for an image-serveable file', async () => {
    db.fabFiles.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'f1',
      mimeType: 'image/png',
      moderationStatus: 'clean',
      fileUrl: 'https://signed',
      fileUrlExpireAt: 123,
    });

    const result: any = await updateDocumentSharing(
      user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: true },
      { db } as any
    );

    expect(result.fileUrl).toBe('https://signed');
  });

  it('strips fileUrl from the response for a non-serveable file (targeted write never touches it)', async () => {
    db.fabFiles.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'f1',
      mimeType: 'image/png',
      moderationStatus: 'pending',
      fileUrl: 'https://signed',
      fileUrlExpireAt: 123,
    });

    const result: any = await updateDocumentSharing(
      user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: true },
      { db } as any
    );

    // response is stripped
    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // the persisted write is targeted to the two flags only - it never carries fileUrl,
    // so the stored URL is left intact.
    const writeArg = db.fabFiles.update.mock.calls[0][0];
    expect(writeArg).toEqual({ id: 'f1', isGlobalRead: true, isGlobalWrite: true });
  });

  it('throws NotFoundError when the caller lacks write access', async () => {
    db.sessions.shareable.findUpdateAccessById.mockResolvedValue(null);
    await expect(
      updateDocumentSharing(user, { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: true }, {
        db,
      } as any)
    ).rejects.toThrow(NotFoundError);
    expect(db.sessions.update).not.toHaveBeenCalled();
  });
});
