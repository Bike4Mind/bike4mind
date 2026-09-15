import { describe, it, expect, vi } from 'vitest';
import { deleteSessionMessage } from './deleteMessage';

describe('deleteSessionMessage', () => {
  const makeAdapters = () => ({
    db: {
      sessions: { findByIdAndUserId: vi.fn().mockResolvedValue({ id: 'session-1' }) },
      chatHistories: {
        findBySessionIdAndId: vi.fn(),
        update: vi.fn(),
      },
    },
  });

  it('soft-deletes the message when it belongs to the session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', deletedAt: null });
    db.chatHistories.update.mockResolvedValueOnce({ id: 'm1', deletedAt: new Date() });

    const result = await deleteSessionMessage('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db });

    expect(db.chatHistories.findBySessionIdAndId).toHaveBeenCalledWith('session-1', 'm1');
    expect(result.deletedAt).not.toBeNull();
  });

  it('throws NotFoundError when the message does not exist or belongs to a different session', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce(null);

    await expect(
      deleteSessionMessage('caller-1', { sessionId: 'session-1', messageId: 'missing' }, { db })
    ).rejects.toThrow('Message not found');
    expect(db.chatHistories.update).not.toHaveBeenCalled();
  });

  // Regression: update()'s return value was previously ignored entirely, so a write that matched
  // nothing (however that happens - update() has no way to know why) would still report success.
  it('throws NotFoundError when update() finds nothing to update', async () => {
    const { db } = makeAdapters();
    db.chatHistories.findBySessionIdAndId.mockResolvedValueOnce({ id: 'm1', deletedAt: null });
    db.chatHistories.update.mockResolvedValueOnce(null);

    await expect(deleteSessionMessage('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db })).rejects.toThrow(
      'Message not found'
    );
  });
});
