import { describe, expect, it } from 'vitest';
import { isSuspectedSignup } from '@client/app/utils/signupSignals';
import {
  BURST_MIN_ACCOUNTS,
  classifyDomainCohorts,
  classifySignup,
  classifySignups,
  localPartTemplate,
  type SignupCandidate,
} from './signupClassifier';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60 * 1000;
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const NOW = at(10 * 24 * 60 * MIN);

const user = (id: string, email: string, offsetMs: number, extra: Partial<SignupCandidate> = {}): SignupCandidate => ({
  id,
  email,
  createdAt: at(offsetMs),
  ...extra,
});

// Deterministic pseudo-random gaps so the "human" cohorts are irregular but stable across runs.
function poissonOffsets(count: number, meanGapMs: number, seed = 7): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const offsets: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += -Math.log(1 - next()) * meanGapMs;
    offsets.push(Math.round(t));
  }
  return offsets;
}

describe('domain cohort signals', () => {
  it('flags a burst of accounts on one non-webmail domain within an hour', () => {
    const users = Array.from({ length: BURST_MIN_ACCOUNTS }, (_, i) => user(`b${i}`, `x${i}@corp.test`, i * 2 * MIN));
    const signals = classifyDomainCohorts(users);
    expect(users.every(u => signals.get(u.id)?.has('domainBurst'))).toBe(true);
  });

  it('does not flag a burst one account short of the threshold', () => {
    const users = Array.from({ length: BURST_MIN_ACCOUNTS - 1 }, (_, i) => user(`b${i}`, `x${i}@corp.test`, i * MIN));
    expect(classifyDomainCohorts(users).size).toBe(0);
  });

  it('catches a slow-drip farm: about one account every 2.3 minutes for six hours', () => {
    const jitter = [0, 20, -15, 30, -25, 10, -5, 25, -30, 15];
    const users = Array.from({ length: 156 }, (_, i) =>
      user(`f${i}`, `ab${i}@farm.test`, i * 138 * 1000 + jitter[i % jitter.length] * 1000)
    );
    const signals = classifyDomainCohorts(users);
    expect(users.every(u => signals.get(u.id)?.has('domainCadence'))).toBe(true);
  });

  it('catches a cadence farm too sparse to ever burst', () => {
    // One account every 8 minutes: 7 per hour, under the burst threshold, for 3 hours.
    const users = Array.from({ length: 22 }, (_, i) =>
      user(`s${i}`, `name${i}x@drip.test`, i * 8 * MIN + (i % 3) * MIN)
    );
    const signals = classifyDomainCohorts(users);
    expect(users.every(u => signals.get(u.id)?.has('domainCadence'))).toBe(true);
    expect(users.some(u => signals.get(u.id)?.has('domainBurst'))).toBe(false);
  });

  it('does not read irregular human arrivals on a company domain as cadence', () => {
    const users = poissonOffsets(30, 20 * MIN).map((offset, i) => user(`h${i}`, `person${i}@company.test`, offset));
    const signals = classifyDomainCohorts(users);
    expect(users.some(u => signals.get(u.id)?.has('domainCadence'))).toBe(false);
  });

  it('never flags major webmail on volume or cadence alone', () => {
    const steady = Array.from({ length: 200 }, (_, i) =>
      user(`g${i}`, `person.name.${String.fromCharCode(97 + (i % 26))}x@gmail.com`, i * 2 * MIN)
    );
    const signals = classifyDomainCohorts(steady);
    expect([...signals.values()].some(set => set.has('domainBurst') || set.has('domainCadence'))).toBe(false);
  });

  it('flags patterned local parts within one domain, including webmail, as a weak signal', () => {
    const users = Array.from({ length: 5 }, (_, i) =>
      user(`p${i}`, `prefix-${100 + i}-${7 * i}@gmail.com`, i * 60 * MIN)
    );
    const signals = classifyDomainCohorts(users);
    expect(users.every(u => signals.get(u.id)?.has('patternedEmail'))).toBe(true);
    expect(isSuspectedSignup(['patternedEmail'])).toBe(false);
  });

  it('does not pattern-match templates spread over more than a day or with too little fixed text', () => {
    const spread = Array.from({ length: 5 }, (_, i) => user(`p${i}`, `prefix-${i}@corp.test`, i * 7 * 60 * MIN));
    expect(classifyDomainCohorts(spread).size).toBe(0);
    expect(localPartTemplate('a12@corp.test')).toBeNull();
    expect(localPartTemplate('plainname@corp.test')).toBeNull();
    expect(localPartTemplate('Prefix-12-345+tag@corp.test')).toBe('prefix-#-#');
  });
});

describe('per-account signals', () => {
  it('flags a datacenter network and a WAF bot label from signup metadata', () => {
    expect(
      classifySignup(
        user('a', 'a@corp.test', 0, { signupMeta: { isDatacenter: true, wafBotSignal: true } }),
        new Set(),
        NOW
      )
    ).toEqual(['wafBotSignal', 'datacenterNetwork']);
  });

  it('treats missing signup metadata as no signal', () => {
    expect(classifySignup(user('a', 'a@corp.test', 0, { signupMeta: null }), new Set(), NOW)).toEqual([]);
    expect(classifySignup(user('a', 'a@corp.test', 0), new Set(), NOW)).toEqual([]);
  });

  it('flags an API key created within 24 hours of signup, not one created later', () => {
    expect(classifySignup(user('a', 'a@corp.test', 0, { firstApiKeyAt: at(23 * 60 * MIN) }), new Set(), NOW)).toEqual([
      'earlyApiKey',
    ]);
    expect(classifySignup(user('a', 'a@corp.test', 0, { firstApiKeyAt: at(25 * 60 * MIN) }), new Set(), NOW)).toEqual(
      []
    );
  });

  it('flags dormancy only once the account is over a day old', () => {
    const dormant = user('a', 'a@corp.test', 0, { lastActiveAt: at(5 * MIN) });
    expect(classifySignup(dormant, new Set(), NOW)).toEqual(['dormantAfterSignup']);
    expect(classifySignup(dormant, new Set(), at(12 * 60 * MIN))).toEqual([]);
    expect(
      classifySignup(user('a', 'a@corp.test', 0, { lastActiveAt: at(3 * 24 * 60 * MIN) }), new Set(), NOW)
    ).toEqual([]);
    expect(classifySignup(user('a', 'a@corp.test', 0, { lastActiveAt: null }), new Set(), NOW)).toEqual([]);
  });
});

describe('suspected verdict', () => {
  it('needs one strong signal or two weak ones', () => {
    expect(isSuspectedSignup([])).toBe(false);
    expect(isSuspectedSignup(['earlyApiKey'])).toBe(false);
    expect(isSuspectedSignup(['datacenterNetwork'])).toBe(false);
    expect(isSuspectedSignup(['earlyApiKey', 'dormantAfterSignup'])).toBe(true);
    expect(isSuspectedSignup(['domainCadence'])).toBe(true);
    expect(isSuspectedSignup(['wafBotSignal'])).toBe(true);
  });

  it('marks the farm suspected while leaving the same-hour gmail signups likely legit', () => {
    const farm = Array.from({ length: 40 }, (_, i) =>
      user(`f${i}`, `zz-${1000 + i}-${i * 3}@farm.test`, i * 138 * 1000, { firstApiKeyAt: at(i * 138 * 1000 + MIN) })
    );
    const humans = poissonOffsets(32, 2 * MIN, 3).map((offset, i) =>
      user(`g${i}`, `someone${'abcdefgh'[i % 8]}@gmail.com`, offset)
    );
    const result = classifySignups([...farm, ...humans], NOW);
    expect(farm.every(u => isSuspectedSignup(result.get(u.id) ?? []))).toBe(true);
    expect(farm.every(u => result.get(u.id)?.includes('earlyApiKey'))).toBe(true);
    expect(humans.some(u => isSuspectedSignup(result.get(u.id) ?? []))).toBe(false);
  });
});
