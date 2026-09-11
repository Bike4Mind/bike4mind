import { describe, it, expect, vi } from 'vitest';
import { membershipOrgIdsForTurn } from './membershipOrgIdsForTurn';

describe('membershipOrgIdsForTurn', () => {
  const repo = (orgIds: string[] = ['orgA']) => ({
    findMembershipOrgIds: vi.fn(async () => orgIds),
  });
  const turn = () => ({});

  it('resolves membership once per turn', async () => {
    const organizations = repo();
    const scope = turn();

    expect(await membershipOrgIdsForTurn(scope, 'u1', organizations)).toEqual(['orgA']);
    expect(await membershipOrgIdsForTurn(scope, 'u1', organizations)).toEqual(['orgA']);
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason this memo is shared rather than one per resolver. Both lake-access resolvers need
   * membership and BOTH run per tool call, so a turn that retrieves and then injects used to issue
   * the read once per resolver per call. Passing the same scope is what makes it one read for the
   * whole turn - and the two resolvers agreeing on "my orgs" by identity rather than by contract is
   * the property #1674 is about.
   */
  it('serves both lake-access resolvers from ONE entry when they share a turn scope', async () => {
    const organizations = repo(['orgA', 'orgB']);
    const scope = turn();

    const retrievalSide = await membershipOrgIdsForTurn(scope, 'u1', organizations);
    const injectionSide = await membershipOrgIdsForTurn(scope, 'u1', organizations);

    expect(injectionSide).toEqual(retrievalSide);
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledTimes(1);
  });

  it('does NOT share an entry between two turns', async () => {
    const organizations = repo();
    await membershipOrgIdsForTurn(turn(), 'u1', organizations);
    await membershipOrgIdsForTurn(turn(), 'u1', organizations);
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledTimes(2);
  });

  it('does NOT share an entry between two users', async () => {
    const organizations = { findMembershipOrgIds: vi.fn(async (userId: string) => [`org-of-${userId}`]) };
    const scope = turn();

    expect(await membershipOrgIdsForTurn(scope, 'u1', organizations)).toEqual(['org-of-u1']);
    expect(await membershipOrgIdsForTurn(scope, 'u2', organizations)).toEqual(['org-of-u2']);
  });

  it('resolves against the CALLING user, not whatever the repo was last asked', async () => {
    const organizations = repo();
    await membershipOrgIdsForTurn(turn(), 'u1', organizations);
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledWith('u1');
  });

  it('does not cache a rejection: both resolvers keep propagating it', async () => {
    // Both call sites resolve this OUTSIDE their fail-safe catch on purpose, so a transient failure
    // surfaces instead of being folded into "member of nothing". A cached rejection would make one
    // failure permanent for the turn - and both resolvers read that absence as a settled deny.
    const organizations = {
      findMembershipOrgIds: vi.fn().mockRejectedValueOnce(new Error('mongo down')).mockResolvedValue(['orgA']),
    };
    const scope = turn();

    await expect(membershipOrgIdsForTurn(scope, 'u1', organizations)).rejects.toThrow('mongo down');
    expect(await membershipOrgIdsForTurn(scope, 'u1', organizations)).toEqual(['orgA']);
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledTimes(2);
  });
});
