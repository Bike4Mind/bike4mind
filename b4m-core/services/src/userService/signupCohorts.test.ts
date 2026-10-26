import { describe, expect, it } from 'vitest';
import { cachedFailOpenLookup, toSignupRecord, type DomainFacts, type SignupFootprint } from './signupClusterKeys';
import { DEFAULT_COHORT_OPTIONS, findCandidateCohorts, type CohortOptions } from './signupCohorts';

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

  it('never caps infrastructure keys by domain count', async () => {
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
      { label: 'signup times in the same 24-hour bucket', domainCount: 3 },
    ]);
  });

  it('links on stored signup data alone when no domain facts are supplied', async () => {
    const createdAt = new Date('2026-03-10T00:00:00Z');
    const stored = grouped.map(r => ({ ...r, asn: 64500, createdAt, isDatacenter: true }));
    const { cohorts } = await findCandidateCohorts(stored, null, DEFAULT_COHORT_OPTIONS);

    expect(cohorts[0].domains).toHaveLength(3);
    expect(cohorts[0].datacenterSignups).toBe(5);
    expect(cohorts[0].reasons).toContain('3 domains share signup ASN 64500');
    expect(cohorts[0].reasons).toContain('3 domains share signup times in the same 24-hour bucket');
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
    const { cohorts } = await findCandidateCohorts(grouped, cachedFailOpenLookup(lookup), OPTIONS);
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example']);
  });

  it('skips caller-supplied shared mailbox domains', async () => {
    const options = { ...OPTIONS, sharedMailboxDomains: ['Quarry.Test'] };
    const { cohorts } = await findCandidateCohorts(grouped, lookupFrom(FACTS), options);
    expect(cohorts[0].domains).toEqual(['harbor.example', 'meadow.example']);
  });
});
