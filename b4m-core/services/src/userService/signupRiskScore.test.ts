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
      wafAnonIp: null,
      wafBotSignal: undefined,
      minutesToFirstApiKey: null,
      creditsSpentFirst24h: null,
    };
    expect(scoreSignupRisk(facts, scoring())).toEqual({ score: 0, signals: [], needsReview: false });
  });

  it('leaves the edge labels out of the score at their default weight of 0', () => {
    expect(WEIGHTS.wafAnonIp).toBe(0);
    expect(WEIGHTS.wafBotSignal).toBe(0);
    expect(scoreSignupRisk({ ...plain, wafAnonIp: true, wafBotSignal: true }, scoring())).toEqual({
      score: 0,
      signals: [],
      needsReview: false,
    });
  });

  it.each([
    ['wafAnonIp', { wafAnonIp: true }],
    ['wafBotSignal', { wafBotSignal: true }],
  ] as const)('adds the %s weight with a reason once a weight is set', (signal, facts) => {
    const config = scoring({ weights: { ...WEIGHTS, wafAnonIp: 12, wafBotSignal: 18 } });
    const points = config.weights[signal];

    expect(scoreSignupRisk({ ...plain, ...facts }, config).signals).toEqual([
      { signal, points, reason: expect.any(String) },
    ]);
    expect(scoreSignupRisk({ ...plain, [signal]: false }, config).score).toBe(0);
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

  it('puts a scripted free-tier signup above the default review threshold', () => {
    // Burner domain, counter-style address, a key minted minutes after signup, then heavy first-day spend.
    const result = scoreSignupRisk(
      {
        email: 'person28af6a@a.example.net',
        riskyDomain: true,
        minutesToFirstApiKey: 4,
        creditsSpentFirst24h: 2000,
      },
      scoring()
    );

    expect(result.signals.map(s => s.signal)).toEqual([
      'riskyDomain',
      'quickApiKey',
      'fastSpend',
      'generatedLocalPart',
    ]);
    expect(result.needsReview).toBe(true);
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

  describe('email subdomain and instant key signals', () => {
    it('applies the subdomain burst at the configured account count, not one below', () => {
      const min = scoring().emailSubdomainBurstAccounts;

      expect(scoreSignupRisk({ ...plain, emailSubdomainSignups: min }, scoring()).signals).toEqual([
        {
          signal: 'emailSubdomainBurst',
          points: WEIGHTS.emailSubdomainBurst,
          reason: `${min} accounts signed up on this email subdomain within 24 hours`,
        },
      ]);
      expect(scoreSignupRisk({ ...plain, emailSubdomainSignups: min - 1 }, scoring()).score).toBe(0);
      expect(scoreSignupRisk({ ...plain, emailSubdomainSignups: null }, scoring()).score).toBe(0);
    });

    it('adds the banned-sibling signal once any account on the subdomain is banned', () => {
      expect(scoreSignupRisk({ ...plain, bannedEmailSubdomainSignups: 2 }, scoring()).score).toBe(
        WEIGHTS.bannedEmailSubdomainSibling
      );
      expect(scoreSignupRisk({ ...plain, bannedEmailSubdomainSignups: 0 }, scoring()).score).toBe(0);
    });

    it('counts a key minted within the instant limit as both instant and quick', () => {
      const seconds = scoring().instantApiKeySeconds;

      expect(
        scoreSignupRisk({ ...plain, minutesToFirstApiKey: seconds / 60 }, scoring()).signals.map(s => s.signal)
      ).toEqual(['instantApiKey', 'quickApiKey']);
      expect(
        scoreSignupRisk({ ...plain, minutesToFirstApiKey: (seconds + 1) / 60 }, scoring()).signals.map(s => s.signal)
      ).toEqual(['quickApiKey']);
    });

    it('applies the instant key even when the quick-key limit is shorter', () => {
      const result = scoreSignupRisk(
        { ...plain, minutesToFirstApiKey: 1.5 },
        scoring({ quickApiKeyMinutes: 1, instantApiKeySeconds: 120 })
      );

      expect(result.signals.map(s => s.signal)).toEqual(['instantApiKey']);
    });

    it('sends a scripted burst on one email subdomain to review, even on a clean domain and network', () => {
      // Several accounts on one subdomain within hours, each minting a key seconds after signup.
      const result = scoreSignupRisk(
        { email: 'qzxkvwplt@box.example.net', emailSubdomainSignups: 10, minutesToFirstApiKey: 0.15 },
        scoring()
      );

      expect(result.signals.map(s => s.signal)).toEqual(['emailSubdomainBurst', 'instantApiKey', 'quickApiKey']);
      expect(result.needsReview).toBe(true);
    });

    it('leaves an ordinary signup that mints a key the same hour out of review', () => {
      const result = scoreSignupRisk(
        {
          email: 'jane.doe@example.com',
          emailSubdomainSignups: null,
          bannedEmailSubdomainSignups: null,
          minutesToFirstApiKey: 25,
        },
        scoring()
      );

      expect(result.signals.map(s => s.signal)).toEqual(['quickApiKey']);
      expect(result.needsReview).toBe(false);
    });

    it('leaves a few colleagues on a shared work subdomain out of review', () => {
      const result = scoreSignupRisk(
        { email: 'jane.doe@dept.example.edu', emailSubdomainSignups: 4, minutesToFirstApiKey: 30 },
        scoring()
      );

      expect(result.needsReview).toBe(false);
    });
  });
});
