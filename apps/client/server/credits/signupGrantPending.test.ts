import { describe, expect, it } from 'vitest';
import { PENDING_FREE_CREDITS_TAG, type SignupGrant } from '@bike4mind/common';
import { buildSignupGrantPending, type SignupGrantPendingInput } from './signupGrantPending';

const SCHEDULE = { dripCap: 900, dailyCredits: 50 };
const NO_REWARDS = { held: { count: 0, credits: 0 }, paused: { count: 0, credits: 0 } };

const grant = (overrides: Partial<SignupGrant> = {}): SignupGrant => ({
  stage: 'signup',
  signupCredits: 100,
  unlockCredits: 900,
  creditsReleased: 300,
  nextCondition: 'verification',
  dripCredits: 200,
  lastDripDay: '2026-11-03',
  ...overrides,
});

const build = (user: SignupGrantPendingInput['user'], extra: Partial<SignupGrantPendingInput> = {}) =>
  buildSignupGrantPending({ user, schedule: SCHEDULE, rewards: NO_REWARDS, viewerIsAdmin: true, ...extra });

describe('buildSignupGrantPending', () => {
  it('reports the schedule and remaining-to-drip of a granted account', () => {
    const pending = build({ signupGrant: grant(), emailVerified: true, tags: [] });
    expect(pending).toMatchObject({
      hasGrant: true,
      source: 'default',
      stage: 'signup',
      held: null,
      blocked: null,
      lastActivityCreditDay: '2026-11-03',
      schedule: {
        signupCredits: 100,
        unlockCredits: 900,
        received: 300,
        dripped: 200,
        dripCap: 900,
        dailyCredits: 50,
        remaining: 700,
        dripRemaining: 700,
      },
    });
    expect(pending.actions.block).toEqual({ available: true, reason: null, permitted: true });
    expect(pending.actions.releaseRemaining.available).toBe(true);
    expect(pending.actions.releaseHeld).toMatchObject({ available: false, reason: 'not_held' });
    expect(pending.actions.unblock).toMatchObject({ available: false, reason: 'not_blocked' });
  });

  it('never reports a negative drip remainder when the cap was lowered below what was dripped', () => {
    const pending = build({ signupGrant: grant({ dripCredits: 1200 }), tags: [] });
    expect(pending.schedule?.dripRemaining).toBe(0);
  });

  it('describes a held tranche and offers its release', () => {
    const pending = build({
      signupGrant: grant({ stage: 'signup', creditsReleased: 0, dripCredits: 0 }),
      signupGrantHeldReason: 'budget_exhausted',
      signupGrantHeldAt: new Date('2026-11-04T10:00:00Z'),
      pendingCreditGrant: 100,
      emailVerified: true,
      tags: [PENDING_FREE_CREDITS_TAG],
    });
    expect(pending.held).toEqual({ reason: 'budget_exhausted', since: '2026-11-04T10:00:00.000Z', credits: 100 });
    expect(pending.actions.releaseHeld).toEqual({ available: true, reason: null, permitted: true });
  });

  it('reports a held tranche on an account with no signup grant record', () => {
    const pending = build({
      signupGrantHeldReason: 'budget_exhausted',
      pendingCreditGrant: 100,
      emailVerified: true,
      tags: [PENDING_FREE_CREDITS_TAG],
    });
    expect(pending.hasGrant).toBe(false);
    expect(pending.held).toMatchObject({ credits: 100, since: null });
    expect(pending.actions.releaseHeld.available).toBe(true);
  });

  it('reads block state, paused rewards and offers unblock', () => {
    const pending = build(
      { signupGrant: grant({ blocked: { at: new Date('2026-11-04T09:00:00Z') } }), tags: [] },
      { rewards: { held: { count: 0, credits: 0 }, paused: { count: 2, credits: 40 } } }
    );
    expect(pending.blocked).toEqual({ at: '2026-11-04T09:00:00.000Z' });
    expect(pending.rewards).toEqual({ queuedCount: 0, queuedCredits: 0, pausedCount: 2, pausedCredits: 40 });
    expect(pending.actions.block).toMatchObject({ available: false, reason: 'already_blocked' });
    expect(pending.actions.unblock.available).toBe(true);
    expect(pending.actions.releaseRemaining).toMatchObject({ available: false, reason: 'blocked' });
  });

  it('reports nothing to drip once the drip is closed', () => {
    const forfeited = build({
      signupGrant: grant({ unlockForfeited: { cause: 'dispute', at: new Date('2026-11-04T00:00:00Z') } }),
      tags: [],
    });
    const verified = build({ signupGrant: grant({ stage: 'unlocked', unlockedBy: 'verification' }), tags: [] });
    expect(forfeited.schedule?.dripRemaining).toBe(0);
    expect(verified.schedule?.dripRemaining).toBe(0);
  });

  it('marks a grant package redemption', () => {
    expect(build({ signupGrant: grant(), grantPackageId: 'pkg-1', tags: [] }).source).toBe('package');
  });

  it('answers an account with no grant: nothing pending and every action explains itself', () => {
    const pending = build({ tags: [] });
    expect(pending).toMatchObject({ hasGrant: false, source: null, stage: null, schedule: null, held: null });
    expect(pending.actions.block).toMatchObject({ available: false, reason: 'no_grant' });
    expect(pending.actions.releaseRemaining).toMatchObject({ available: false, reason: 'no_grant' });
    expect(pending.actions.releaseHeld).toMatchObject({ available: false, reason: 'no_grant' });
  });

  it('withholds release-remaining from a delegated admin but leaves the other actions permitted', () => {
    const pending = build({ signupGrant: grant(), tags: [] }, { viewerIsAdmin: false });
    expect(pending.actions.releaseRemaining.permitted).toBe(false);
    expect(pending.actions.block.permitted).toBe(true);
    expect(pending.actions.releaseHeld.permitted).toBe(true);
  });

  it('counts queued rewards separately from paused ones', () => {
    const pending = build(
      { signupGrant: grant(), tags: [] },
      { rewards: { held: { count: 3, credits: 75 }, paused: { count: 0, credits: 0 } } }
    );
    expect(pending.rewards).toMatchObject({ queuedCount: 3, queuedCredits: 75, pausedCount: 0 });
  });
});
