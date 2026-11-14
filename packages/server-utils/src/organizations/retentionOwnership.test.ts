import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findById } }));
import { resolveRetentionOrganization } from './retentionOwnership';

const user = { id: 'member', organizationId: 'selected' } as IUserDocument;
beforeEach(() => vi.clearAllMocks());
describe('retention creation ownership', () => {
  it('binds a validated team member', async () => {
    findById.mockResolvedValue({
      id: 'org',
      userId: 'owner',
      personal: false,
      users: [{ userId: 'member', permissions: ['read'] }],
    });
    expect(await resolveRetentionOrganization(user, 'org')).toBe('org');
  });
  it.each([
    null,
    { id: 'org', userId: 'owner', personal: true, users: [{ userId: 'member', permissions: ['read'] }] },
    { id: 'org', userId: 'owner', personal: false, users: [] },
    { id: 'org', userId: 'owner', personal: false, users: [{ userId: 'member', permissions: [] }] },
  ])('does not bind missing, personal, stale or nonmember selections', async org => {
    findById.mockResolvedValue(org);
    expect(await resolveRetentionOrganization(user, 'org')).toBeUndefined();
  });
  it('binds the notebook org, not the selected one', async () => {
    findById.mockResolvedValue({
      id: 'org',
      userId: 'owner',
      personal: false,
      users: [{ userId: 'member', permissions: ['read'] }],
    });
    await resolveRetentionOrganization(user, 'org');
    expect(findById).toHaveBeenCalledWith('org');
  });
  it('does not look up an organization for a notebook with none', async () => {
    expect(await resolveRetentionOrganization(user)).toBeUndefined();
    expect(findById).not.toHaveBeenCalled();
  });
});
