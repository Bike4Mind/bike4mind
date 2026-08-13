import { describe, it, expect } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import {
  canManageLake,
  isEffectiveOwner,
  isLakeCreator,
  resolveEffectiveOwnerIds,
  type LakeGrant,
  type ManageActor,
} from './manageRule';

// The manage decision only reads createdByUserId + organizationId off the lake.
const lake = (createdByUserId = 'creator', organizationId?: string) =>
  ({ createdByUserId, organizationId }) as Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>;

const actor = (over: Partial<ManageActor> = {}): ManageActor => ({ userId: 'u', isAdmin: false, ...over });

const grant = (principalType: LakeGrant['principalType'], principalId: string, role: LakeGrant['role']): LakeGrant => ({
  principalType,
  principalId,
  role,
});

describe('resolveEffectiveOwnerIds', () => {
  it('falls back to the creator when there are no grants', () => {
    expect(resolveEffectiveOwnerIds(lake('creator'), [])).toEqual(['creator']);
    expect(resolveEffectiveOwnerIds(lake('creator'))).toEqual(['creator']);
  });

  it('an owner-role user grant SUPERSEDES the creator (transfer semantics)', () => {
    const grants = [grant('user', 'newOwner', 'owner')];
    expect(resolveEffectiveOwnerIds(lake('creator'), grants)).toEqual(['newOwner']);
  });

  it('returns every owner-grant holder, deduped, and ignores curator/reader/org grants', () => {
    const grants = [
      grant('user', 'a', 'owner'),
      grant('user', 'a', 'owner'),
      grant('user', 'b', 'owner'),
      grant('user', 'c', 'curator'),
      grant('user', 'd', 'reader'),
      grant('organization', 'org1', 'owner'),
    ];
    expect(resolveEffectiveOwnerIds(lake('creator'), grants).sort()).toEqual(['a', 'b']);
  });

  it('fails closed to an empty set for a blank creator with no owner grant (fallback lake)', () => {
    expect(resolveEffectiveOwnerIds(lake(''), [])).toEqual([]);
  });
});

describe('isLakeCreator', () => {
  it('matches only the immutable creator, guarding blank identities', () => {
    expect(isLakeCreator(lake('creator'), { userId: 'creator' })).toBe(true);
    expect(isLakeCreator(lake('creator'), { userId: 'other' })).toBe(false);
    expect(isLakeCreator(lake(''), { userId: '' })).toBe(false);
  });

  it('does NOT follow an owner grant (creator is provenance, not effective ownership)', () => {
    // isLakeCreator is grant-blind on purpose - it is the provenance identity.
    expect(isLakeCreator(lake('creator'), { userId: 'newOwner' })).toBe(false);
  });
});

describe('isEffectiveOwner', () => {
  it('is the creator when no owner grant exists', () => {
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'creator' }), [])).toBe(true);
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'stranger' }), [])).toBe(false);
  });

  it('follows a transfer: the new owner is effective owner, the former creator is not', () => {
    const grants = [grant('user', 'newOwner', 'owner')];
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'newOwner' }), grants)).toBe(true);
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'creator' }), grants)).toBe(false);
  });

  it('is NOT satisfied by admin, curator, or org-admin (owner-only predicate)', () => {
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'x', isAdmin: true }), [])).toBe(false);
    expect(isEffectiveOwner(lake('creator'), actor({ userId: 'cur' }), [grant('user', 'cur', 'curator')])).toBe(false);
    expect(isEffectiveOwner(lake('creator', 'org1'), actor({ userId: 'x', administeredOrgIds: ['org1'] }), [])).toBe(
      false
    );
  });
});

describe('canManageLake', () => {
  it('rung 1: platform admin manages any lake', () => {
    expect(canManageLake(lake('creator'), actor({ userId: 'root', isAdmin: true }))).toBe(true);
  });

  it('rung 2: the effective owner manages - creator when ungranted, new owner after transfer', () => {
    expect(canManageLake(lake('creator'), actor({ userId: 'creator' }))).toBe(true);
    const transferred = [grant('user', 'newOwner', 'owner')];
    expect(canManageLake(lake('creator'), actor({ userId: 'newOwner' }), transferred)).toBe(true);
    // The superseded creator can no longer manage - the core succession guarantee.
    expect(canManageLake(lake('creator'), actor({ userId: 'creator' }), transferred)).toBe(false);
  });

  it('rung 3: a curator user grant manages; a reader grant does NOT', () => {
    expect(canManageLake(lake('creator'), actor({ userId: 'cur' }), [grant('user', 'cur', 'curator')])).toBe(true);
    expect(canManageLake(lake('creator'), actor({ userId: 'rdr' }), [grant('user', 'rdr', 'reader')])).toBe(false);
  });

  it('rung 4: an admin of the lake org manages an org-scoped lake, but not an org-less one', () => {
    const orgAdmin = actor({ userId: 'orgAdmin', administeredOrgIds: ['org1'] });
    expect(canManageLake(lake('creator', 'org1'), orgAdmin)).toBe(true);
    // Not an admin of THIS lake's org.
    expect(canManageLake(lake('creator', 'org2'), orgAdmin)).toBe(false);
    // Org-less lake: the org rung cannot apply.
    expect(canManageLake(lake('creator'), orgAdmin)).toBe(false);
  });

  it('rung 5: an owner/curator ORG grant for an org the actor administers manages', () => {
    const member = actor({ userId: 'member', administeredOrgIds: ['orgX'] });
    expect(canManageLake(lake('creator'), member, [grant('organization', 'orgX', 'curator')])).toBe(true);
    // A reader org grant does not confer management.
    expect(canManageLake(lake('creator'), member, [grant('organization', 'orgX', 'reader')])).toBe(false);
    // The org grant is for an org this actor does not administer.
    expect(
      canManageLake(lake('creator'), actor({ userId: 'member', administeredOrgIds: ['orgY'] }), [
        grant('organization', 'orgX', 'owner'),
      ])
    ).toBe(false);
  });

  it('denies a stranger with no grant and no org rights', () => {
    expect(canManageLake(lake('creator', 'org1'), actor({ userId: 'stranger' }))).toBe(false);
  });

  it('fails closed on a blank identity even for a blank-creator lake', () => {
    expect(canManageLake(lake(''), actor({ userId: '' }))).toBe(false);
  });
});
