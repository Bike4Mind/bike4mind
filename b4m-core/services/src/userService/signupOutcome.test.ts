import { describe, expect, it } from 'vitest';
import { classifySignupOutcome, SIGNUP_ACTIVATION_WINDOW_MS, type SignupOutcomeUser } from './signupOutcome';

const signedUpAt = new Date('2026-10-01T00:00:00Z');
const afterWindow = new Date(signedUpAt.getTime() + SIGNUP_ACTIVATION_WINDOW_MS);
const insideWindow = new Date(signedUpAt.getTime() + SIGNUP_ACTIVATION_WINDOW_MS - 1);
const firstRequest = new Date(signedUpAt.getTime() + 60_000);

const user = (overrides: Partial<SignupOutcomeUser> = {}): SignupOutcomeUser => ({
  createdAt: signedUpAt,
  emailVerified: true,
  isBanned: false,
  isModerated: false,
  signupGrant: undefined,
  signupGrantAssessment: undefined,
  signupGrantHeldReason: null,
  riskScore: null,
  ...overrides,
});

describe('classifySignupOutcome', () => {
  it('labels a verified, unflagged account with an AI request in the window as legitimate', () => {
    expect(classifySignupOutcome(user(), firstRequest, afterWindow)).toBe('legitimate');
    expect(classifySignupOutcome(user(), firstRequest, insideWindow)).toBe('legitimate');
  });

  it.each([
    ['banned', { isBanned: true }],
    ['moderated', { isModerated: true }],
    ['held for risk review', { signupGrantHeldReason: 'risk_review' as const }],
    ['pending admin risk review', { riskScore: { reviewState: 'pending' } as SignupOutcomeUser['riskScore'] }],
  ])('labels a %s account as suspected even when it was active', (_label, overrides) => {
    expect(classifySignupOutcome(user(overrides), firstRequest, afterWindow)).toBe('suspected');
    expect(classifySignupOutcome(user(overrides), firstRequest, insideWindow)).toBe('suspected');
  });

  it('labels a held review-band grant as suspected', () => {
    const held = user({
      signupGrant: {
        stage: 'signup',
        signupCredits: 10,
        unlockCredits: 0,
        creditsReleased: 0,
        nextCondition: 'verification',
      },
      signupGrantAssessment: {
        band: 'review',
        credits: 0,
        score: 9,
        reasons: [],
        missing: [],
        policyVersion: 'v1',
        status: 'evaluated',
      },
    });
    expect(classifySignupOutcome(held, firstRequest, afterWindow)).toBe('suspected');
  });

  it('waits for the window to close before labeling an inactive or unverified account', () => {
    expect(classifySignupOutcome(user(), null, insideWindow)).toBe('undecided');
    expect(classifySignupOutcome(user({ emailVerified: false }), firstRequest, insideWindow)).toBe('undecided');
    expect(classifySignupOutcome(user(), null, afterWindow)).toBe('suspected');
    expect(classifySignupOutcome(user({ emailVerified: false }), firstRequest, afterWindow)).toBe('suspected');
  });

  it('rejects an account without a valid signup time', () => {
    expect(() => classifySignupOutcome(user({ createdAt: new Date(Number.NaN) }), firstRequest, afterWindow)).toThrow(
      'Signup outcome needs a valid signup time'
    );
  });
});
