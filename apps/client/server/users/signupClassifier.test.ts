import { describe, expect, it } from 'vitest';
import { isSuspectedSignup } from '@client/app/utils/signupSignals';
import {
  BURST_MIN_ACCOUNTS,
  classifyDomainCohorts,
  classifySignup,
  classifySignupClusters,
  classifySignups,
  localPartTemplate,
  networkPrefix,
  SHARED_NETWORK_MIN_ACCOUNTS,
  SPIKE_MIN_ACCOUNTS,
  spikeHours,
  type SignupCandidate,
} from './signupClassifier';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60 * 1000;
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = at(10 * DAY);

/** An ordinary account that came back two days after signup unless `extra` says otherwise. */
const user = (id: string, email: string, offsetMs: number, extra: Partial<SignupCandidate> = {}): SignupCandidate => ({
  id,
  email,
  createdAt: at(offsetMs),
  lastActiveAt: at(offsetMs + 2 * DAY),
  ...extra,
});

/** Digit-free unique names (`a`, `b`, ... `ba`), so test addresses never share a patternedEmail template. */
const letters = (n: number): string =>
  n.toString(26).replace(/./g, digit => String.fromCharCode(97 + parseInt(digit, 26)));

/** Signups per UTC hour, the shape getSignupTimeseries passes to classifySignups. */
const hourlyCountsOf = (users: SignupCandidate[]) => {
  const counts = new Map<number, number>();
  for (const { createdAt } of users) {
    const hour = Math.floor(createdAt.getTime() / HOUR) * HOUR;
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return counts;
};

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
  });

  it('reads an account that was never active as dormant once it is over a day old', () => {
    const neverActive = user('a', 'a@gmail.com', 0, { lastActiveAt: null });
    expect(classifySignup(neverActive, new Set(), NOW)).toEqual(['dormantAfterSignup']);
    expect(classifySignup(neverActive, new Set(), at(12 * HOUR))).toEqual([]);
  });

  it('does not call an API-first developer dormant or suspected', () => {
    const developer = user('a', 'a@corp.test', 0, {
      lastActiveAt: at(20 * MIN),
      firstApiKeyAt: at(10 * MIN),
      lastApiUseAt: at(2 * 24 * 60 * MIN),
    });
    const signals = classifySignup(developer, new Set(), NOW);
    expect(signals).toEqual(['earlyApiKey']);
    expect(isSuspectedSignup(signals)).toBe(false);
    expect(classifySignup({ ...developer, lastApiUseAt: at(30 * MIN) }, new Set(), NOW)).toEqual([
      'earlyApiKey',
      'dormantAfterSignup',
    ]);
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

describe('network and inbox clusters', () => {
  it('reduces addresses to their /24 or /64 and rejects what does not parse', () => {
    expect(networkPrefix('198.51.100.23')).toBe('198.51.100.0/24');
    expect(networkPrefix('::ffff:198.51.100.23')).toBe('198.51.100.0/24');
    expect(networkPrefix('2001:db8:aa:1::5')).toBe('2001:db8:aa:1::/64');
    expect(networkPrefix('2001:0db8:00aa:0001:ffff:0:0:1')).toBe('2001:db8:aa:1::/64');
    expect(networkPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkPrefix('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(networkPrefix('::FFFF:198.51.100.23')).toBe('198.51.100.0/24');
    expect(networkPrefix('999.1.1.1')).toBeNull();
    expect(networkPrefix('not-an-ip')).toBeNull();
    expect(networkPrefix(null)).toBeNull();
  });

  it('flags accounts sharing one network range within a day, Gmail included', () => {
    const farm = Array.from({ length: SHARED_NETWORK_MIN_ACCOUNTS }, (_, i) =>
      user(`n${i}`, `person${i}@gmail.com`, i * 3 * HOUR, { signupMeta: { ip: `198.51.100.${10 + i}` } })
    );
    const signals = classifySignupClusters(farm);
    expect(farm.every(u => signals.get(u.id)?.has('sharedNetwork'))).toBe(true);
    expect(isSuspectedSignup(['sharedNetwork'])).toBe(false);
  });

  it('does not flag a network range one account short, spread over more than a day, or across ranges', () => {
    const short = Array.from({ length: SHARED_NETWORK_MIN_ACCOUNTS - 1 }, (_, i) =>
      user(`s${i}`, `s${i}@gmail.com`, i * HOUR, { signupMeta: { ip: '198.51.100.7' } })
    );
    const spread = Array.from({ length: SHARED_NETWORK_MIN_ACCOUNTS }, (_, i) =>
      user(`w${i}`, `w${i}@gmail.com`, i * 13 * HOUR, { signupMeta: { ip: '203.0.113.7' } })
    );
    const distinct = Array.from({ length: 5 }, (_, i) =>
      user(`d${i}`, `d${i}@gmail.com`, i * MIN, { signupMeta: { ip: `192.0.${i}.9` } })
    );
    expect(classifySignupClusters([...short, ...spread, ...distinct]).size).toBe(0);
  });

  it('flags addresses that deliver to one Gmail inbox through dots and plus tags', () => {
    const aliases = [
      user('a1', 'jane.doe@gmail.com', 0),
      user('a2', 'janedoe+1@gmail.com', HOUR),
      user('a3', 'j.a.n.e.doe@googlemail.com', 2 * HOUR),
    ];
    const other = user('o', 'jane.doe2@gmail.com', 3 * HOUR);
    const signals = classifySignupClusters([...aliases, other]);
    expect(aliases.every(u => signals.get(u.id)?.has('aliasedEmail'))).toBe(true);
    expect(signals.has('o')).toBe(false);
  });
});

describe('signup spike', () => {
  const HOUR0 = Math.floor(T0 / HOUR) * HOUR + 30 * DAY;

  it('marks an hour at the floor over a quiet baseline, and not one below it', () => {
    expect(spikeHours(new Map([[HOUR0, SPIKE_MIN_ACCOUNTS]]))).toEqual(new Set([HOUR0]));
    expect(spikeHours(new Map([[HOUR0, SPIKE_MIN_ACCOUNTS - 1]])).size).toBe(0);
  });

  it('scales with the baseline, so steady growth is not a spike', () => {
    // Two signups every hour for four weeks: the baseline median is 2, so a spike needs 20.
    const busy = new Map(Array.from({ length: 28 * 24 }, (_, i) => [HOUR0 - (i + 1) * HOUR, 2] as const));
    expect(spikeHours(new Map([...busy, [HOUR0, 19]])).has(HOUR0)).toBe(false);
    expect(spikeHours(new Map([...busy, [HOUR0, 20]])).has(HOUR0)).toBe(true);
  });

  it('marks never-active accounts from a Gmail spike suspected, but not real users in the same hour', () => {
    const start = HOUR0 - T0;
    const wave = Array.from({ length: 40 }, (_, i) =>
      user(`b${i}`, `wave${letters(i)}@gmail.com`, start + i * MIN, { lastActiveAt: null })
    );
    const returning = Array.from({ length: 5 }, (_, i) =>
      user(`r${i}`, `realperson${letters(i)}@gmail.com`, start + i * 7 * MIN)
    );
    const all = [...wave, ...returning];
    const result = classifySignups(all, new Date(HOUR0 + 3 * DAY), hourlyCountsOf(all));
    expect(wave.every(u => result.get(u.id)?.join() === 'dormantAfterSignup,signupSpike')).toBe(true);
    expect(wave.every(u => isSuspectedSignup(result.get(u.id) ?? []))).toBe(true);
    expect(returning.every(u => result.get(u.id)?.join() === 'signupSpike')).toBe(true);
    expect(returning.some(u => isSuspectedSignup(result.get(u.id) ?? []))).toBe(false);
  });

  it('leaves four weeks of ordinary Gmail signups at normal volume likely legit', () => {
    const ordinary = poissonOffsets(60, 11 * HOUR, 11).map((offset, i) =>
      user(`g${i}`, `first.${letters(i)}.last@gmail.com`, offset, {
        lastActiveAt: at(offset + (i % 3 === 0 ? 30 * MIN : 3 * DAY)),
        signupMeta: { ip: `10.${i}.${i % 7}.1` },
      })
    );
    const now = at(40 * DAY);
    const result = classifySignups(ordinary, now, hourlyCountsOf(ordinary));
    expect(ordinary.some(u => isSuspectedSignup(result.get(u.id) ?? []))).toBe(false);
    expect([...result.values()].some(signals => signals.includes('signupSpike'))).toBe(false);
  });
});
