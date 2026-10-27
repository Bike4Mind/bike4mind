import { describe, expect, it } from 'vitest';
import {
  cachedFailOpenLookup,
  toSignupRecord,
  type ClusterKey,
  type DomainFacts,
  type SignupFootprint,
} from './signupClusterKeys';
import {
  buildDomainProfiles,
  DEFAULT_COHORT_OPTIONS,
  findCandidateCohorts,
  groupDomainProfiles,
  type CohortOptions,
} from './signupCohorts';

const OPTIONS: CohortOptions = { ...DEFAULT_COHORT_OPTIONS, localPartShapes: ['alpha+digits'] };
const SHARED_MX = { mxHosts: ['mx.shared-mail.example'] };
const SHARED_NS = { nameservers: ['ns.shared-dns.example'] };
const lookupFrom = (facts: Record<string, DomainFacts>) => async (domain: string) => facts[domain] ?? null;

let nextId = 0;
const record = (email: string, extra: Partial<SignupFootprint> = {}) =>
  toSignupRecord({ userId: `user-${++nextId}`, email, ...extra }, OPTIONS);

const harbor = [record('sam2041@harbor.example'), record('kim77@harbor.example')];
const meadow = [record('lee1902@mail.meadow.example')];
const quarry = [record('ana315@quarry.test'), record('bo48@quarry.test')];
const grouped = [...harbor, ...meadow, ...quarry];
const FACTS = { 'harbor.example': SHARED_MX, 'meadow.example': SHARED_MX, 'quarry.test': SHARED_MX };

describe('findCandidateCohorts', () => {
  it('groups domains that share an MX host and a local-part shape into one cohort', async () => {
    const other = [record('jane.doe@other.example'), record('casey@unrelated.test')];
    const { cohorts } = await findCandidateCohorts(
      [...grouped, ...other],
      lookupFrom({ ...FACTS, 'other.example': SHARED_MX }),
      OPTIONS
    );

    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example', 'quarry.test']);
    expect(cohorts[0].members.map(m => m.userId).sort()).toEqual(grouped.map(r => r.userId).sort());
    expect(cohorts[0].reasons).toEqual([
      'cohort of 3 domains, 5 users',
      '3 domains share local-part shape alpha+digits',
      '3 domains share MX hosts mx.shared-mail.example',
    ]);
  });

  it('does not link domains on a single shared key kind', async () => {
    expect((await findCandidateCohorts(grouped, lookupFrom({}), OPTIONS)).cohorts).toEqual([]);
    expect((await findCandidateCohorts(grouped, lookupFrom(FACTS), DEFAULT_COHORT_OPTIONS)).cohorts).toEqual([]);
  });

  it('skips MX hosts of ignored shared providers', async () => {
    const options = { ...OPTIONS, ignoredInfrastructureHosts: ['shared-mail.example'] };
    expect((await findCandidateCohorts(grouped, lookupFrom(FACTS), options)).cohorts).toEqual([]);
  });

  it('does not apply the broad-key cap to infrastructure keys', async () => {
    const { cohorts, commonKeys } = await findCandidateCohorts(grouped, lookupFrom(FACTS), {
      ...OPTIONS,
      maxDomainsPerKey: 1,
    });
    expect(cohorts[0].domains).toHaveLength(3);
    expect(commonKeys).toEqual([]);
  });

  it('reports a broad user key over the cap as common instead of linking on it', async () => {
    const createdAt = new Date('2026-03-10T00:00:00Z');
    const stored = grouped.map(r => ({ ...r, asn: 64500, createdAt }));
    const { cohorts, commonKeys } = await findCandidateCohorts(stored, null, {
      ...DEFAULT_COHORT_OPTIONS,
      maxDomainsPerKey: 2,
    });
    expect(cohorts).toEqual([]);
    expect(commonKeys).toEqual([
      { label: 'signup ASN 64500', domainCount: 3 },
      { label: 'signup times in the 24-hour window from 2026-03-09T12:00:00.000Z', domainCount: 3 },
      { label: 'signup times in the 24-hour window from 2026-03-10T00:00:00.000Z', domainCount: 3 },
    ]);
  });

  it('reports an infrastructure key over its cap as common without enumerating pairs', async () => {
    const records = ['a', 'b', 'c', 'd'].map(name => record(`sam2041@${name}.example`));
    const facts = Object.fromEntries(records.map(r => [r.domain!, { ...SHARED_MX, ...SHARED_NS }]));
    const { cohorts, commonKeys } = await findCandidateCohorts(records, lookupFrom(facts), {
      ...OPTIONS,
      maxDomainsPerInfraKey: 3,
    });
    expect(cohorts).toEqual([]);
    expect(commonKeys.map(key => key.label)).toEqual(
      expect.arrayContaining(['MX hosts mx.shared-mail.example', 'nameservers ns.shared-dns.example'])
    );
  });

  it('analyzes a long chain of linked domains without overflowing the stack', () => {
    const count = 20000;
    const profiles = Array.from({ length: count }, (_, i) => ({
      domain: `d${i}.example`,
      members: [],
      keys: [
        { kind: 'mx' as const, value: `mx${i}`, label: `MX hosts mx${i}` },
        { kind: 'ns' as const, value: `ns${i}`, label: `nameservers ns${i}` },
        { kind: 'mx' as const, value: `mx${i + 1}`, label: `MX hosts mx${i + 1}` },
        { kind: 'ns' as const, value: `ns${i + 1}`, label: `nameservers ns${i + 1}` },
      ],
    }));
    const { cohorts } = groupDomainProfiles(profiles, { ...OPTIONS, maxCohortDomains: count });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].tooBroad).toBe(false);
    expect(cohorts[0].bridgeDomains).toEqual(
      profiles
        .slice(1, -1)
        .map(profile => profile.domain)
        .sort()
    );
  });

  it('counts widespread keys by distinct domain, including repeated keys and profiles', () => {
    const count = 20000;
    const key: ClusterKey = { kind: 'asn', value: '64500', label: 'signup ASN 64500' };
    const profiles = Array.from({ length: count }, (_, index) => ({
      domain: `d${index}.example`,
      members: [],
      keys: [key, key],
    }));
    const result = groupDomainProfiles([...profiles, profiles[0]], OPTIONS);
    expect(result).toEqual({ cohorts: [], commonKeys: [{ label: key.label, domainCount: count }] });
  });

  it.each([
    {
      pairs: [
        ['a', 'b'],
        ['a', 'c'],
      ],
      bridges: ['a.example'],
    },
    {
      pairs: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
      bridges: [],
    },
    {
      pairs: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['c', 'd'],
      ],
      bridges: ['c.example'],
    },
  ])('finds articulation domains for $pairs', ({ pairs, bridges }) => {
    const domains = [...new Set(pairs.flat())];
    const profiles = domains.map(domain => ({
      domain: `${domain}.example`,
      members: [],
      keys: pairs.flatMap(([left, right], index): ClusterKey[] =>
        domain === left || domain === right
          ? [
              { kind: 'mx', value: `mx${index}`, label: `MX hosts mx${index}` },
              { kind: 'ns', value: `ns${index}`, label: `nameservers ns${index}` },
            ]
          : []
      ),
    }));
    expect(groupDomainProfiles(profiles, OPTIONS).cohorts[0].bridgeDomains).toEqual(bridges);
  });

  it('keeps different signup windows in one cohort as separate reasons', () => {
    const at = (iso: string) => ({ kind: 'signupWindow' as const, value: iso, label: 'same-looking window' });
    const mx = { kind: 'mx' as const, value: 'm', label: 'MX hosts m' };
    const profiles = [
      { domain: 'a.example', members: [], keys: [at('1'), mx] },
      { domain: 'b.example', members: [], keys: [at('1'), mx] },
      { domain: 'c.example', members: [], keys: [at('2'), mx] },
      { domain: 'd.example', members: [], keys: [at('2'), mx] },
      { domain: 'e.example', members: [], keys: [at('1'), at('2'), mx] },
    ];
    const { cohorts } = groupDomainProfiles(profiles, { ...OPTIONS, minSharedKeyKinds: 2 });
    expect(cohorts[0].reasons.filter(reason => reason === '3 domains share same-looking window')).toHaveLength(2);
  });

  it('links on stored signup data alone when no domain facts are supplied', async () => {
    const createdAt = new Date('2026-03-10T00:00:00Z');
    const stored = grouped.map(r => ({ ...r, asn: 64500, createdAt, isDatacenter: true }));
    const { cohorts } = await findCandidateCohorts(stored, null, DEFAULT_COHORT_OPTIONS);

    expect(cohorts[0].domains).toHaveLength(3);
    expect(cohorts[0].datacenterSignups).toBe(5);
    expect(cohorts[0].reasons).toContain('3 domains share signup ASN 64500');
    expect(cohorts[0].reasons).toContain(
      '3 domains share signup times in the 24-hour window from 2026-03-10T00:00:00.000Z'
    );
  });

  it('records edges and marks a domain the cohort depends on', async () => {
    const facts = {
      'harbor.example': SHARED_MX,
      'meadow.example': { ...SHARED_MX, ...SHARED_NS },
      'quarry.test': SHARED_NS,
    };
    const { cohorts } = await findCandidateCohorts(grouped, lookupFrom(facts), OPTIONS);

    expect(cohorts[0].edges).toEqual([
      { domains: ['harbor.example', 'meadow.example'], kinds: ['localPartShape', 'mx'] },
      { domains: ['meadow.example', 'quarry.test'], kinds: ['localPartShape', 'ns'] },
    ]);
    expect(cohorts[0].bridgeDomains).toEqual(['meadow.example']);
    expect(cohorts[0].reasons).toContain('connectivity depends on meadow.example');
    expect(cohorts[0].reasons).toContain('2 domains share MX hosts mx.shared-mail.example');
  });

  it('flags a cohort over maxCohortDomains as too broad', async () => {
    const { cohorts } = await findCandidateCohorts(grouped, lookupFrom(FACTS), { ...OPTIONS, maxCohortDomains: 2 });
    expect(cohorts[0].tooBroad).toBe(true);
    expect(cohorts[0].reasons[0]).toBe('too broad: 3 domains exceeds 2, review edges');
  });

  it('fails open when a lookup throws for some domains', async () => {
    const lookup = async (domain: string) => {
      if (domain === 'quarry.test') throw new Error('lookup unavailable');
      return (FACTS as Record<string, DomainFacts>)[domain] ?? null;
    };
    const { cohorts } = await findCandidateCohorts(
      grouped,
      cachedFailOpenLookup(lookup, () => undefined),
      OPTIONS
    );
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example']);
  });

  it('skips caller-supplied shared mailbox domains', async () => {
    const options = { ...OPTIONS, sharedMailboxDomains: ['Quarry.Test'] };
    const { cohorts } = await findCandidateCohorts(grouped, lookupFrom(FACTS), options);
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example']);
  });

  it('excludes a mailbox domain given as a subdomain with a trailing dot and mixed case', async () => {
    const options = { ...OPTIONS, sharedMailboxDomains: ['Mail.Quarry.Test.'] };
    const { cohorts } = await findCandidateCohorts(grouped, lookupFrom(FACTS), options);
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example']);
  });
});

describe('groupDomainProfiles guards and determinism', () => {
  const key = (kind: ClusterKey['kind'], value: string): ClusterKey => ({ kind, value, label: `${kind} ${value}` });

  it('does not link domains that share only signup windows of both grids', () => {
    const windows = [key('signupWindow', 'a1'), key('signupWindow', 'b1')];
    const profiles = [
      { domain: 'a.example', members: [], keys: windows },
      { domain: 'b.example', members: [], keys: windows },
    ];
    expect(groupDomainProfiles(profiles, OPTIONS).cohorts).toEqual([]);
  });

  it('drops a user key carried by fewer than minUserKeyShare of a domain users', () => {
    const at = (domain: string, asn: number | null, n: number) => record(`sam${n}@${domain}`, { asn });
    const records = [
      at('a.example', 64500, 1),
      at('a.example', null, 2),
      at('a.example', null, 3),
      at('b.example', 64500, 4),
      at('b.example', null, 5),
      at('b.example', null, 6),
    ];
    const options = { ...DEFAULT_COHORT_OPTIONS, minSharedKeyKinds: 1 };
    const profiles = buildDomainProfiles(records, new Map(), options);
    expect(profiles.flatMap(p => p.keys).filter(k => k.kind === 'asn')).toEqual([]);
    const kept = buildDomainProfiles(records, new Map(), { ...options, minUserKeyShare: 0.3 });
    expect(kept.flatMap(p => p.keys).filter(k => k.kind === 'asn')).toHaveLength(2);
  });

  it('requires minDomains domains in a cohort', async () => {
    const two = [...harbor, ...meadow];
    const facts = lookupFrom(FACTS);
    expect((await findCandidateCohorts(two, facts, OPTIONS)).cohorts).toHaveLength(1);
    expect((await findCandidateCohorts(two, facts, { ...OPTIONS, minDomains: 3 })).cohorts).toEqual([]);
    expect((await findCandidateCohorts(grouped, facts, { ...OPTIONS, minDomains: 3 })).cohorts).toHaveLength(1);
  });

  it('produces identical output whatever the input profile order', () => {
    const facts = new Map<string, DomainFacts | null>([
      ['harbor.example', { ...SHARED_MX, ...SHARED_NS }],
      ['meadow.example', { ...SHARED_MX, ...SHARED_NS }],
      ['quarry.test', SHARED_NS],
    ]);
    const stamped = grouped.map((r, index) => ({ ...r, createdAt: new Date(Date.UTC(2026, 2, 10, index)) }));
    const profiles = buildDomainProfiles(stamped, facts, OPTIONS);
    const forward = groupDomainProfiles(profiles, OPTIONS);
    const reversed = groupDomainProfiles(
      [...profiles].reverse().map(p => ({ ...p, members: [...p.members].reverse(), keys: [...p.keys].reverse() })),
      OPTIONS
    );
    expect(forward.cohorts).toHaveLength(1);
    expect(reversed).toEqual(forward);
  });

  it('orders edges by domain pair whatever the input profile order', () => {
    const pairs = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ];
    const profiles = ['a', 'b', 'c', 'd'].map(name => ({
      domain: `${name}.example`,
      members: [],
      keys: pairs.flatMap(([left, right], index) =>
        name === left || name === right ? [key('mx', `mx${index}`), key('ns', `ns${index}`)] : []
      ),
    }));
    const expected = pairs.map(([left, right]) => [`${left}.example`, `${right}.example`]);
    for (const input of [profiles, [...profiles].reverse()]) {
      expect(groupDomainProfiles(input, OPTIONS).cohorts[0].edges.map(edge => edge.domains)).toEqual(expected);
    }
  });
});
