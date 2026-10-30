import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockSelect, mockLean, mockRecord } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockSelect: vi.fn(),
  mockLean: vi.fn(),
  mockRecord: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: { findById: (...a: unknown[]) => mockFindById(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  adminAuditService: { REDACTED_PLACEHOLDER: '[REDACTED]' },
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
}));

import { diffProfileFields, profileFieldsSent, readProfileSnapshot, recordProfileUpdate } from './profileUpdateAudit';

beforeEach(() => {
  mockLean.mockReset().mockResolvedValue({ name: 'Ada' });
  mockSelect.mockReset().mockReturnValue({ lean: mockLean });
  mockFindById.mockReset().mockReturnValue({ select: mockSelect });
  mockRecord.mockReset().mockResolvedValue(null);
});

describe('profileFieldsSent', () => {
  it('drops fields audited under their own action and request-only fields', () => {
    const body = {
      id: 'u1',
      isAdmin: true,
      roleChangeReason: 'r',
      currentCredits: 5,
      creditDelta: 1,
      creditReason: 'c',
      isBanned: true,
      isModerated: true,
      statusChangeReason: 's',
      name: 'Ada',
      email: 'a@example.com',
    };
    expect(profileFieldsSent(body)).toEqual(['name', 'email']);
  });

  it('ignores undefined values but keeps null and empty values', () => {
    expect(profileFieldsSent({ name: undefined, tags: null, username: '' })).toEqual(['tags', 'username']);
  });
});

describe('readProfileSnapshot', () => {
  it('selects the stored path for each field', async () => {
    const snapshot = await readProfileSnapshot('u1', ['name', 'moderationStatus']);
    expect(mockFindById).toHaveBeenCalledWith('u1');
    expect(mockSelect).toHaveBeenCalledWith('name moderation.status');
    expect(snapshot).toEqual({ name: 'Ada' });
  });

  it('never reads password or securityQuestions', async () => {
    await readProfileSnapshot('u1', ['name', 'password', 'securityQuestions']);
    expect(mockSelect).toHaveBeenCalledWith('name');
  });

  it('skips the read entirely when only secret fields were sent', async () => {
    expect(await readProfileSnapshot('u1', ['password', 'securityQuestions'])).toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });
});

describe('diffProfileFields', () => {
  it('returns only the fields whose value changed', () => {
    const changes = diffProfileFields(
      ['name', 'email'],
      { name: 'Ada', email: 'a@example.com' },
      { name: 'Grace', email: 'a@example.com' }
    );
    expect(changes).toEqual([{ field: 'name', before: 'Ada', after: 'Grace' }]);
  });

  it('compares structured values by content', () => {
    expect(diffProfileFields(['tags'], { tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toEqual([]);
    expect(diffProfileFields(['tags'], { tags: ['a'] }, { tags: ['a', 'b'] })).toEqual([
      { field: 'tags', before: ['a'], after: ['a', 'b'] },
    ]);
  });

  it('reads moderationStatus from the nested moderation.status path', () => {
    const changes = diffProfileFields(
      ['moderationStatus'],
      { moderation: { status: 'active' } },
      { moderation: { status: 'banned' } }
    );
    expect(changes).toEqual([{ field: 'moderationStatus', before: 'active', after: 'banned' }]);
  });

  it('treats a missing snapshot as undefined values', () => {
    expect(diffProfileFields(['name'], null, { name: 'Ada' })).toEqual([
      { field: 'name', before: undefined, after: 'Ada' },
    ]);
  });

  it('always records password and securityQuestions as redacted on both sides', () => {
    const changes = diffProfileFields(['password', 'securityQuestions'], null, null);
    expect(changes).toEqual([
      { field: 'password', before: '[REDACTED]', after: '[REDACTED]' },
      { field: 'securityQuestions', before: '[REDACTED]', after: '[REDACTED]' },
    ]);
  });
});

describe('recordProfileUpdate', () => {
  const req = { user: { id: 'admin1' } } as unknown as Parameters<typeof recordProfileUpdate>[0];
  const target = { kind: 'user' as const, id: 'u1', displayName: 'Ada' };

  it('writes nothing when there are no changes', async () => {
    await recordProfileUpdate(req, { target, changes: [] });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records user.profile.updated naming the changed fields', async () => {
    const changes = [
      { field: 'name', before: 'Ada', after: 'Grace' },
      { field: 'email', before: 'a@x.com', after: 'g@x.com' },
    ];
    await recordProfileUpdate(req, { target, changes });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(req, {
      action: 'user.profile.updated',
      target,
      summary: 'updated name, email',
      changes,
    });
  });
});
