import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRequestMembershipOrgIds, type MembershipRequest } from './requestMembership';

const { mockFindMembershipOrgIds } = vi.hoisted(() => ({ mockFindMembershipOrgIds: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findMembershipOrgIds: mockFindMembershipOrgIds },
}));

describe('getRequestMembershipOrgIds', () => {
  beforeEach(() => {
    mockFindMembershipOrgIds.mockReset();
  });

  it('memoizes on the request object - two awaits, one repository call', async () => {
    mockFindMembershipOrgIds.mockResolvedValue(['org-1']);
    const req = { user: { id: 'u1' } } as unknown as MembershipRequest;
    expect(await getRequestMembershipOrgIds(req)).toEqual(['org-1']);
    expect(await getRequestMembershipOrgIds(req)).toEqual(['org-1']);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledTimes(1);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledWith('u1');
  });

  it('memoizes an empty set too (??= semantics, not ||=)', async () => {
    mockFindMembershipOrgIds.mockResolvedValue([]);
    const req = { user: { id: 'u1' } } as unknown as MembershipRequest;
    expect(await getRequestMembershipOrgIds(req)).toEqual([]);
    expect(await getRequestMembershipOrgIds(req)).toEqual([]);
    expect(mockFindMembershipOrgIds).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a nullish user without touching the repository', async () => {
    expect(await getRequestMembershipOrgIds({} as MembershipRequest)).toEqual([]);
    expect(mockFindMembershipOrgIds).not.toHaveBeenCalled();
  });
});
