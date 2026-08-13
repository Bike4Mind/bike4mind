import { describe, it, expect } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { canAccessLake } from './assertLakeAccess';
import type { LakeGrant } from './manageRule';

// A private lake: no org, no gate. Reachable only by owner/admin (Private-by-default).
const privateLake = (createdByUserId = 'creator') =>
  ({
    createdByUserId,
    organizationId: undefined,
    requiredUserTag: undefined,
    requiredEntitlement: undefined,
    isPublic: false,
  }) as Pick<
    IDataLakeDocument,
    'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >;

const ctx = (userId: string): AccessContext => ({ userId, isAdmin: false, userTags: [] });

const ownerGrant = (principalId: string): LakeGrant => ({ principalType: 'user', principalId, role: 'owner' });
const curatorGrant = (principalId: string): LakeGrant => ({ principalType: 'user', principalId, role: 'curator' });

describe('canAccessLake honors access grants at the single read gate (#1668 regression)', () => {
  it('denies a stranger a private lake when no grant is threaded', () => {
    expect(canAccessLake(privateLake('creator'), ctx('stranger'))).toBe(false);
  });

  it('admits the NEW owner of a transferred private lake, and denies the superseded creator', () => {
    const grants = [ownerGrant('newOwner')];
    // Without this fix the new owner would be denied at the read gate before any manage check.
    expect(canAccessLake(privateLake('creator'), ctx('newOwner'), grants)).toBe(true);
    // The former creator is no longer the effective owner and the lake grants them nothing else.
    expect(canAccessLake(privateLake('creator'), ctx('creator'), grants)).toBe(false);
  });

  it('admits a curator of a private lake (a manager can always read what they manage)', () => {
    expect(canAccessLake(privateLake('creator'), ctx('cur'), [curatorGrant('cur')])).toBe(true);
  });

  it('still admits the creator when no owner grant supersedes them', () => {
    expect(canAccessLake(privateLake('creator'), ctx('creator'))).toBe(true);
  });
});
