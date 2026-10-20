import { describe, expect, it } from 'vitest';
import { orgManagerNames } from './orgManagerNames';

describe('orgManagerNames', () => {
  const base = {
    userId: 'owner',
    users: [{ userId: 'owner' }, { userId: 'm1' }, { userId: 'm2' }],
    userDetails: [
      { id: 'm1', name: 'Manager One', email: 'm1@example.com' },
      { id: 'm2', name: '', email: 'm2@example.com' },
    ],
  };

  it('names each manager on the roster, falling back to email', () => {
    expect(orgManagerNames({ ...base, adminUserIds: ['m1', 'm2'] })).toEqual(['Manager One', 'm2@example.com']);
  });

  it('skips a stale manager entry with no users[] row', () => {
    expect(orgManagerNames({ ...base, adminUserIds: ['m1', 'gone'] })).toEqual(['Manager One']);
  });

  it('lists the legacy managerId even without a users[] row, by id when it has no details', () => {
    expect(orgManagerNames({ ...base, adminUserIds: [], managerId: 'legacy' })).toEqual(['legacy']);
  });

  it('never lists the owner or ordinary members', () => {
    expect(orgManagerNames({ ...base, adminUserIds: ['owner'] })).toEqual([]);
  });
});
