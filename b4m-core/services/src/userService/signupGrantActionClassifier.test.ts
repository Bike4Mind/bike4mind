import { describe, expect, it } from 'vitest';
import { PENDING_FREE_CREDITS_TAG, type SignupGrant } from '@bike4mind/common';
import { classifySignupGrantAction, type ClassifiableUser } from './signupGrantActionClassifier';

const grant = (overrides: Partial<SignupGrant> = {}): SignupGrant => ({
  stage: 'signup',
  signupCredits: 10,
  unlockCredits: 40,
  creditsReleased: 10,
  nextCondition: 'verification',
  ...overrides,
});

const user = (overrides: Partial<ClassifiableUser> = {}): ClassifiableUser => ({
  signupGrant: grant(),
  ...overrides,
});

const held = (overrides: Partial<ClassifiableUser> = {}) =>
  user({
    signupGrantHeldReason: 'budget_exhausted',
    tags: [PENDING_FREE_CREDITS_TAG],
    emailVerified: true,
    ...overrides,
  });

describe('classifySignupGrantAction', () => {
  it.each(['block', 'unblock', 'release_held', 'release_remaining'] as const)('refuses %s with no grant', action => {
    expect(classifySignupGrantAction({}, action, 50)).toEqual({ eligible: false, reason: 'no_grant' });
    expect(classifySignupGrantAction(null, action, 50)).toEqual({ eligible: false, reason: 'no_grant' });
  });

  it('allows a block only on an unblocked grant', () => {
    expect(classifySignupGrantAction(user(), 'block')).toEqual({ eligible: true });
    expect(classifySignupGrantAction(user({ signupGrant: grant({ blocked: { at: new Date() } }) }), 'block')).toEqual({
      eligible: false,
      reason: 'already_blocked',
    });
  });

  it('allows an unblock only on a blocked grant', () => {
    expect(classifySignupGrantAction(user(), 'unblock')).toEqual({ eligible: false, reason: 'not_blocked' });
    expect(classifySignupGrantAction(user({ signupGrant: grant({ blocked: { at: new Date() } }) }), 'unblock')).toEqual(
      {
        eligible: true,
      }
    );
  });

  it('releases a held tranche only when it is held for the pool and not blocked', () => {
    expect(classifySignupGrantAction(held(), 'release_held')).toEqual({ eligible: true });
    expect(classifySignupGrantAction(user(), 'release_held')).toEqual({ eligible: false, reason: 'not_held' });
    expect(
      classifySignupGrantAction(held({ signupGrant: grant({ blocked: { at: new Date() } }) }), 'release_held')
    ).toEqual({ eligible: false, reason: 'blocked' });
  });

  it('treats a held tranche on an account with no signup grant as releasable, like the bulk release', () => {
    expect(classifySignupGrantAction(held({ signupGrant: undefined }), 'release_held')).toEqual({ eligible: true });
  });

  it.each([
    ['an unverified email', { emailVerified: false }],
    ['a suspended account', { isBanned: true }],
    ['a pending dispute', { disputePending: true }],
    ['revoked AI access', { isModerated: true }],
  ])('withholds a held release for %s, as the release itself does', (_label, overrides) => {
    expect(classifySignupGrantAction(held(overrides), 'release_held')).toEqual({ eligible: false, reason: 'withheld' });
  });

  it('leaves a tranche held for review to the review queue', () => {
    const review = held({ signupGrantAssessment: { band: 'review', status: 'evaluated' } as never });
    const result = classifySignupGrantAction({ ...review, signupGrant: grant({ creditsReleased: 0 }) }, 'release_held');
    expect(result).toEqual({ eligible: false, reason: 'held_for_review' });
  });

  it('releases the remainder only when something is left under the live cap', () => {
    expect(classifySignupGrantAction(user(), 'release_remaining', 50)).toEqual({ eligible: true });
    expect(
      classifySignupGrantAction(user({ signupGrant: grant({ creditsReleased: 60 }) }), 'release_remaining', 50)
    ).toEqual({
      eligible: false,
      reason: 'nothing_remaining',
    });
    expect(
      classifySignupGrantAction(user({ signupGrant: grant({ stage: 'pending_email' }) }), 'release_remaining', 50)
    ).toEqual({ eligible: false, reason: 'tranche_pending' });
  });
});
