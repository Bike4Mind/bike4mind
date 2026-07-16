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

  it('updates a session and persists the sharing flags', async () => {
    db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 's1',
      isGlobalRead: false,
      isGlobalWrite: false,
    });

    const result = await updateDocumentSharing(
      user,
      { id: 's1', type: 'sessions', isGlobalRead: true, isGlobalWrite: false },
      { db } as any
    );

    expect(db.sessions.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', isGlobalRead: true, isGlobalWrite: false })
    );
    expect(result).toMatchObject({ isGlobalRead: true, isGlobalWrite: false });
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

  it('strips fileUrl from the response (not the persisted write) for a non-serveable file', async () => {
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
    // but the persisted write still carried the real URL (strip is response-only)
    expect(db.fabFiles.update).toHaveBeenCalledWith(expect.objectContaining({ fileUrl: 'https://signed' }));
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
