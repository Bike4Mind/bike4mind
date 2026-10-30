import { describe, it, expect } from 'vitest';
import { SignupRiskScoringSchema, type SignupRiskScoring } from '@bike4mind/common';
import { looksGeneratedLocalPart, scoreSignupRisk, type SignupRiskFacts } from './signupRiskScore';

const scoring = (overrides: Partial<SignupRiskScoring> = {}): SignupRiskScoring => ({
  ...SignupRiskScoringSchema.parse({}),
  ...overrides,
});
const WEIGHTS = SignupRiskScoringSchema.parse({}).weights;
const plain: SignupRiskFacts = { email: 'jane.doe@example.com' };

describe('looksGeneratedLocalPart', () => {
  it.each(['merlin28af6a@example.net', 'person28aa82@a.example.net', 'Name1f2e3d@example.org'])('flags %s', email =>
    expect(looksGeneratedLocalPart(email)).toBe(true)
  );

  it.each([
    'john1985@example.com', // digits only, no hex letter
    'jane.doe@example.com',
    'ab1c@example.com', // suffix too short
    'cafe@example.com',
    'name28af6ax@example.com', // ends in a non-hex letter
    '28af6a@example.com', // no letter prefix
    '',
  ])('leaves %j alone', email => expect(looksGeneratedLocalPart(email)).toBe(false));
});

describe('scoreSignupRisk', () => {
  it('scores an account with no signals 0, and unknown facts add nothing', () => {
    const facts: SignupRiskFacts = {
      ...plain,
      riskyDomain: null,
      burstCohort: undefined,
      isDatacenter: null,
      minutesToFirstApiKey: null,
      creditsSpentFirst24h: null,
    };
    expect(scoreSignupRisk(facts, scoring())).toEqual({ score: 0, signals: [], needsReview: false });
  });

  it.each([
    ['riskyDomain', { riskyDomain: true }],
    ['burstCohort', { burstCohort: true }],
    ['datacenterNetwork', { isDatacenter: true }],
    ['quickApiKey', { minutesToFirstApiKey: 5 }],
    ['fastSpend', { creditsSpentFirst24h: 5000 }],
    ['generatedLocalPart', { email: 'merlin28af6a@example.net' }],
  ] as const)('adds the %s weight with a reason', (signal, facts) => {
    const result = scoreSignupRisk({ ...plain, ...facts }, scoring());

    expect(result.score).toBe(WEIGHTS[signal]);
    expect(result.signals).toEqual([{ signal, points: WEIGHTS[signal], reason: expect.any(String) }]);
  });

  it('counts a key minted exactly at the quick-key limit, not one minute later', () => {
    const limit = scoring().quickApiKeyMinutes;

    expect(scoreSignupRisk({ ...plain, minutesToFirstApiKey: limit }, scoring()).score).toBe(WEIGHTS.quickApiKey);
    expect(scoreSignupRisk({ ...plain, minutesToFirstApiKey: limit + 1 }, scoring()).score).toBe(0);
    expect(scoreSignupRisk({ ...plain, minutesToFirstApiKey: -1 }, scoring()).score).toBe(0);
  });

  it('scales fast spend with the credits spent, up to its full weight', () => {
    const config = scoring({ fastSpendCredits: 1000, weights: { ...WEIGHTS, fastSpend: 20 } });

    expect(scoreSignupRisk({ ...plain, creditsSpentFirst24h: 500 }, config).score).toBe(10);
    expect(scoreSignupRisk({ ...plain, creditsSpentFirst24h: 1000 }, config).score).toBe(20);
    expect(scoreSignupRisk({ ...plain, creditsSpentFirst24h: 50_000 }, config).score).toBe(20);
    expect(scoreSignupRisk({ ...plain, creditsSpentFirst24h: Number.NaN }, config).score).toBe(0);
  });

  it('drops a signal whose weight is 0', () => {
    const result = scoreSignupRisk(
      { ...plain, isDatacenter: true, riskyDomain: true },
      scoring({ weights: { ...WEIGHTS, datacenterNetwork: 0 } })
    );

    expect(result.signals.map(s => s.signal)).toEqual(['riskyDomain']);
  });

  it('caps the score at 100', () => {
    const result = scoreSignupRisk(
      {
        email: 'merlin28af6a@example.net',
        riskyDomain: true,
        burstCohort: true,
        isDatacenter: true,
        minutesToFirstApiKey: 3,
        creditsSpentFirst24h: 5000,
      },
      scoring()
    );

    expect(result.signals).toHaveLength(6);
    expect(result.score).toBe(100);
  });

  it('needs review at the threshold, not below it', () => {
    const facts = { ...plain, riskyDomain: true, isDatacenter: true }; // 25 + 15 with the defaults

    expect(scoreSignupRisk(facts, scoring({ reviewThreshold: 40 })).needsReview).toBe(true);
    expect(scoreSignupRisk(facts, scoring({ reviewThreshold: 41 })).needsReview).toBe(false);
  });

  // The shape the review queue exists for: generated addresses on a fresh domain, a key minted right
  // away, then steady API spend. No single signal crosses the threshold; together they do.
  it('sends a scripted free-tier account to review and leaves a typical new user alone', () => {
    const scripted = scoreSignupRisk(
      {
        email: 'person28aa82@ab.example.net',
        riskyDomain: true,
        isDatacenter: false,
        minutesToFirstApiKey: 4,
        creditsSpentFirst24h: 800,
      },
      scoring()
    );
    const typical = scoreSignupRisk(
      { email: 'jane.doe@example.com', riskyDomain: false, isDatacenter: false, creditsSpentFirst24h: 120 },
      scoring()
    );

    expect(scripted.needsReview).toBe(true);
    expect(scripted.signals.map(s => s.signal)).toEqual([
      'riskyDomain',
      'quickApiKey',
      'fastSpend',
      'generatedLocalPart',
    ]);
    expect(typical.needsReview).toBe(false);
    expect(typical.score).toBeLessThan(10);
  });
});
