import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { requestModerationAppeal, MODERATION_APPEAL_MAX_LENGTH } from './requestModerationAppeal';

describe('userService - requestModerationAppeal', () => {
  let users: { findById: Mock; recordModerationAppeal: Mock };
  const adapters = () => ({ db: { users } });

  beforeEach(() => {
    vi.clearAllMocks();
    users = { findById: vi.fn(), recordModerationAppeal: vi.fn() };
  });

  it('records an appeal for a suspended user', async () => {
    users.findById.mockResolvedValue({ id: 'u1', moderation: { status: 'suspended' } });
    users.recordModerationAppeal.mockResolvedValue({ id: 'u1' });

    await requestModerationAppeal('u1', '  please review  ', adapters());

    // Trimmed before persisting.
    expect(users.recordModerationAppeal).toHaveBeenCalledWith('u1', 'please review');
  });

  it.each(['throttled', 'suspend_pending', 'suspended'])('allows appeals when status is %s', async status => {
    users.findById.mockResolvedValue({ id: 'u1', moderation: { status } });
    users.recordModerationAppeal.mockResolvedValue({ id: 'u1' });

    await expect(requestModerationAppeal('u1', 'hi', adapters())).resolves.toBeDefined();
  });

  it('rejects an empty appeal', async () => {
    await expect(requestModerationAppeal('u1', '   ', adapters())).rejects.toThrow(/required/i);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects an over-long appeal', async () => {
    const tooLong = 'x'.repeat(MODERATION_APPEAL_MAX_LENGTH + 1);
    await expect(requestModerationAppeal('u1', tooLong, adapters())).rejects.toThrow(/or fewer/i);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects when the user does not exist', async () => {
    users.findById.mockResolvedValue(null);
    await expect(requestModerationAppeal('u1', 'hi', adapters())).rejects.toThrow(/not found/i);
  });

  it('rejects when there is no active moderation action (status active/absent)', async () => {
    users.findById.mockResolvedValue({ id: 'u1', moderation: { status: 'active' } });
    await expect(requestModerationAppeal('u1', 'hi', adapters())).rejects.toThrow(/no active moderation/i);

    users.findById.mockResolvedValue({ id: 'u1' });
    await expect(requestModerationAppeal('u1', 'hi', adapters())).rejects.toThrow(/no active moderation/i);

    expect(users.recordModerationAppeal).not.toHaveBeenCalled();
  });
});
