import { describe, expect, it } from 'vitest';
import type { LinkRuleFacts } from '@bike4mind/common';
import {
  decideLinkRules,
  evaluateLinkRules,
  MIN_DOMAIN_CLUSTER_ACCOUNTS,
  MIN_DOMAIN_CLUSTER_SPENDERS,
} from './linkRules';

const quiet = (over: Partial<LinkRuleFacts> = {}): LinkRuleFacts => ({
  userId: 'u1',
  paying: false,
  partnerDomain: false,
  creditsSpent: 0,
  ownedDomainCluster: null,
  adminHeldDomain: null,
  bannedSameDevice: 0,
  ...over,
});
const cluster = (accounts: number, spenders: number) => ({ domain: 'example.com', accounts, spenders });

describe('evaluateLinkRules', () => {
  it('fires nothing on an account with no linking facts', () => {
    expect(evaluateLinkRules(quiet())).toBeNull();
    expect(evaluateLinkRules(quiet({ bannedSameDevice: null, creditsSpent: 500 }))).toBeNull();
  });

  describe('sharedOwnedDomain', () => {
    it('fires at the account and spender thresholds, and not one below either', () => {
      expect(MIN_DOMAIN_CLUSTER_ACCOUNTS).toBe(3);
      expect(MIN_DOMAIN_CLUSTER_SPENDERS).toBe(2);
      expect(evaluateLinkRules(quiet({ creditsSpent: 10, ownedDomainCluster: cluster(3, 2) }))).toEqual({
        rule: 'sharedOwnedDomain',
        tier: 'limit',
        why: '3 accounts on example.com, 2 spent credits',
      });
      expect(evaluateLinkRules(quiet({ creditsSpent: 10, ownedDomainCluster: cluster(2, 2) }))).toBeNull();
      expect(evaluateLinkRules(quiet({ creditsSpent: 10, ownedDomainCluster: cluster(3, 1) }))).toBeNull();
    });

    it('holds the grant, never limits, an account in the cluster that has not spent', () => {
      expect(evaluateLinkRules(quiet({ creditsSpent: 0, ownedDomainCluster: cluster(4, 2) }))).toMatchObject({
        rule: 'sharedOwnedDomain',
        tier: 'holdGrant',
      });
    });
  });

  describe('heldSignupDomain', () => {
    it('holds the grant on an admin-held domain without any spend', () => {
      expect(evaluateLinkRules(quiet({ adminHeldDomain: 'held.example' }))).toEqual({
        rule: 'heldSignupDomain',
        tier: 'holdGrant',
        why: 'signup domain held.example blocked by an admin',
      });
    });
  });

  describe('bannedSameDevice', () => {
    it('limits an account that spent on a banned account device', () => {
      expect(evaluateLinkRules(quiet({ bannedSameDevice: 1, creditsSpent: 5 }))).toEqual({
        rule: 'bannedSameDevice',
        tier: 'limit',
        why: 'same device as 1 banned account(s), spent credits',
      });
    });

    it('does not fire without spend since signup, or with the device unknown', () => {
      expect(evaluateLinkRules(quiet({ bannedSameDevice: 3, creditsSpent: 0 }))).toBeNull();
      expect(evaluateLinkRules(quiet({ bannedSameDevice: null, creditsSpent: 5 }))).toBeNull();
    });
  });

  it.each([
    ['paying', { paying: true }],
    ['partner domain', { partnerDomain: true }],
  ])('never touches a %s account, whatever fires', (_label, over) => {
    expect(
      evaluateLinkRules(
        quiet({
          ...over,
          creditsSpent: 100,
          bannedSameDevice: 2,
          ownedDomainCluster: cluster(5, 5),
          adminHeldDomain: 'held.example',
        })
      )
    ).toBeNull();
  });

  it('prefers limit over holdGrant, then bannedSameDevice, sharedOwnedDomain, heldSignupDomain', () => {
    const all = quiet({
      creditsSpent: 100,
      bannedSameDevice: 1,
      ownedDomainCluster: cluster(3, 2),
      adminHeldDomain: 'held.example',
    });
    expect(evaluateLinkRules(all)).toMatchObject({ rule: 'bannedSameDevice', tier: 'limit' });
    expect(evaluateLinkRules({ ...all, bannedSameDevice: 0 })).toMatchObject({
      rule: 'sharedOwnedDomain',
      tier: 'limit',
    });
    // Unspent: both are holdGrant, so precedence order decides.
    expect(evaluateLinkRules({ ...all, creditsSpent: 0 })).toMatchObject({
      rule: 'sharedOwnedDomain',
      tier: 'holdGrant',
    });
    expect(evaluateLinkRules({ ...all, creditsSpent: 0, ownedDomainCluster: null })).toMatchObject({
      rule: 'heldSignupDomain',
    });
  });
});

describe('decideLinkRules', () => {
  it('is null when no account fires', () => {
    expect(decideLinkRules([])).toBeNull();
    expect(decideLinkRules([quiet(), quiet({ userId: 'u2' })])).toBeNull();
  });

  it('acts on fired accounts only, at holdGrant when none needs limit', () => {
    expect(decideLinkRules([quiet({ adminHeldDomain: 'held.example' }), quiet({ userId: 'u2' })])).toEqual({
      tier: 'holdGrant',
      userIds: ['u1'],
      rules: ['heldSignupDomain'],
      reason: 'signup domain held.example blocked by an admin',
    });
  });

  it('merges to limit when any fired account needs it, listing every rule in precedence order', () => {
    const decided = decideLinkRules([
      quiet({ adminHeldDomain: 'held.example' }),
      quiet({ userId: 'u2', creditsSpent: 3, bannedSameDevice: 1 }),
      quiet({ userId: 'u3', paying: true, creditsSpent: 3, bannedSameDevice: 1 }),
    ]);
    expect(decided).toMatchObject({
      tier: 'limit',
      userIds: ['u1', 'u2'],
      rules: ['bannedSameDevice', 'heldSignupDomain'],
    });
  });
});
