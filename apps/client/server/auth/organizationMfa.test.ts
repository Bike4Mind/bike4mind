import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ membership: vi.fn(), exists: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findMembershipOrgIds: mocks.membership },
  Organization: { exists: mocks.exists },
}));
import { requiresOrganizationMfaEnrollment } from './organizationMfa';

const user = { id: 'member' } as IUserDocument;
const now = new Date('2030-01-10T00:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue(['personal', 'team-a', 'team-b']);
  mocks.exists.mockImplementation(async filter => {
    const policies = [
      { id: 'personal', personal: true, required: true, deadline: now },
      { id: 'team-a', personal: false, required: false, deadline: now },
      { id: 'team-b', personal: false, required: true, deadline: now },
    ];
    return (
      policies.find(
        org =>
          filter._id.$in.includes(org.id) &&
          org.personal === filter.personal &&
          org.required === filter['mfaPolicy.required'] &&
          org.deadline <= filter['mfaPolicy.graceEndsAt'].$lte
      ) ?? null
    );
  });
});

describe('login org enrollment policy', () => {
  it('checks every membership, not the active org, and includes the deadline boundary', async () => {
    expect(await requiresOrganizationMfaEnrollment(user, now)).toBe(true);
    expect(mocks.membership).toHaveBeenCalledWith('member');
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: { $in: ['personal', 'team-a', 'team-b'] },
      personal: false,
      'mfaPolicy.required': true,
      'mfaPolicy.graceEndsAt': { $ne: null, $lte: now },
    });
  });
  it('preserves login during grace', async () => {
    expect(await requiresOrganizationMfaEnrollment(user, new Date(now.getTime() - 1))).toBe(false);
  });
  it('ignores disabled and personal org policies', async () => {
    mocks.membership.mockResolvedValue(['personal', 'team-a']);
    expect(await requiresOrganizationMfaEnrollment(user, now)).toBe(false);
  });
  it('preserves login without a member org', async () => {
    mocks.membership.mockResolvedValue([]);
    expect(await requiresOrganizationMfaEnrollment(user, now)).toBe(false);
    expect(mocks.exists).not.toHaveBeenCalled();
  });
  it('does not apply human enrollment to service accounts', async () => {
    expect(await requiresOrganizationMfaEnrollment({ ...user, serviceAccountOrganizationId: 'team' }, now)).toBe(false);
    expect(mocks.membership).not.toHaveBeenCalled();
  });
});
