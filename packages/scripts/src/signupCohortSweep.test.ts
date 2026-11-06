import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { userService } from '@bike4mind/services';
import {
  buildSweepOptions,
  COHORT_CSV_COLUMNS,
  parseDomainFactsFile,
  parseSignupSelection,
  renderCohortCsv,
} from './signupCohortSweep';

describe('parseDomainFactsFile', () => {
  it('normalizes domain keys and coerces dates', () => {
    const facts = parseDomainFactsFile({
      'Harbor.Example': { mxHosts: ['mx.mail.example'], registrar: 'Registrar Example', registeredAt: '2026-03-10' },
    });
    expect(facts.get('harbor.example')).toEqual({
      mxHosts: ['mx.mail.example'],
      registrar: 'Registrar Example',
      registeredAt: new Date('2026-03-10'),
    });
  });

  it('keys facts by registrable domain', () => {
    const facts = parseDomainFactsFile({ 'Mail.Harbor.Example': { registrar: 'Registrar Example' } });
    expect([...facts.keys()]).toEqual(['harbor.example']);
  });

  it('rejects two entries that normalize to the same registrable domain', () => {
    expect(() => parseDomainFactsFile({ 'mail.acme.com': {}, 'acme.com': {} })).toThrow(
      /more than one entry for acme\.com/
    );
  });

  it('rejects a key that is not a domain', () => {
    expect(() => parseDomainFactsFile({ com: {} })).toThrow(/not a registrable domain/);
  });

  it('rejects a malformed file', () => {
    expect(() => parseDomainFactsFile({ 'harbor.example': { mxHosts: 'mx.mail.example' } })).toThrow();
  });
});

describe('renderCohortCsv', () => {
  const csv = renderCohortCsv({
    cohorts: [
      {
        domains: ['harbor.example', 'quarry.test'],
        members: [
          { userId: 'u1', domain: 'harbor.example', createdAt: new Date('2026-03-10T00:00:00Z') },
          { userId: 'u2', domain: '=quarry.test', createdAt: null },
        ],
        datacenterSignups: 1,
        edges: [{ domains: ['harbor.example', 'quarry.test'], kinds: ['mx', 'ns'] }],
        bridgeDomains: [],
        tooBroad: false,
        reasons: ['cohort of 2 domains, 2 users', '2 domains share MX hosts mx.mail.example'],
      },
    ],
    commonKeys: [{ label: 'signup ASN 64500', domainCount: 80 }],
  });
  const lines = csv.trim().split('\n');

  it('writes one quoted row per member user with edges and reasons', () => {
    expect(lines[0]).toBe(COHORT_CSV_COLUMNS.join(','));
    expect(lines[1]).toBe(
      '"member","1","review","2","2","1","harbor.example quarry.test","","harbor.example|quarry.test:mx+ns","u1","harbor.example","2026-03-10T00:00:00.000Z","cohort of 2 domains, 2 users; 2 domains share MX hosts mx.mail.example"'
    );
    expect(lines[2]).toContain('"\'=quarry.test"');
  });

  it.each(['+1', '-1', '@x', '\tx', '\rx'])('defuses a spreadsheet formula prefix in %j', value => {
    const [, row] = renderCohortCsv({
      cohorts: [
        {
          domains: ['harbor.example', 'quarry.test'],
          members: [{ userId: value, domain: 'harbor.example', createdAt: null }],
          datacenterSignups: 0,
          edges: [],
          bridgeDomains: [],
          tooBroad: false,
          reasons: [],
        },
      ],
      commonKeys: [],
    }).split('\n');
    expect(row).toContain(`"'${value}"`);
  });

  it('lists common keys with their domain counts', () => {
    expect(lines[3]).toBe('"common_key","","","80","","","","","","","","","signup ASN 64500"');
  });
});

describe('the signup cohort sweep stays read-only', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  it.each(['signup-cohort-sweep.ts', 'signupCohortSweep.ts'])('%s calls no write method', file => {
    const source = readFileSync(path.join(root, file), 'utf8');
    expect(source).not.toMatch(
      /\.(updateOne|updateMany|deleteOne|deleteMany|findOneAnd\w+|findByIdAnd\w+|insertOne|insertMany|bulkWrite|bulkSave|replaceOne|remove|save|create|drop\w*)\s*\(|\$out\b|\$merge\b/
    );
  });
});

describe('buildSweepOptions', () => {
  const defaults: userService.CohortOptions = {
    localPartShapes: [],
    ignoredInfrastructureHosts: [],
    minHexLength: 8,
    registrationBucketDays: 7,
    signupBucketHours: 24,
    minSharedKeyKinds: 2,
    minDomains: 2,
    maxDomainsPerKey: 50,
    maxDomainsPerInfraKey: 500,
    maxCohortDomains: 20,
    minUserKeyShare: 0.5,
    sharedMailboxDomains: [],
  };

  it('falls back to the defaults for omitted flags', () => {
    expect(buildSweepOptions({}, defaults)).toEqual(defaults);
  });

  it.each([{ localPartShapes: ['hex'] }, { localPartShapes: 'any' }] as const)(
    'preserves configured list defaults including $localPartShapes',
    ({ localPartShapes }) => {
      const configured = {
        ...defaults,
        localPartShapes,
        ignoredInfrastructureHosts: ['shared-mail.example'],
        sharedMailboxDomains: ['mailbox.example'],
      };
      expect(buildSweepOptions({}, configured)).toEqual(configured);
    }
  );

  it('allows explicitly empty flags to clear configured lists', () => {
    const options = buildSweepOptions(
      { shapes: '', 'ignore-hosts': '', 'mailbox-domains': '' },
      {
        ...defaults,
        localPartShapes: ['hex'],
        ignoredInfrastructureHosts: ['shared-mail.example'],
        sharedMailboxDomains: ['mailbox.example'],
      }
    );
    expect(options).toMatchObject({
      localPartShapes: [],
      ignoredInfrastructureHosts: [],
      sharedMailboxDomains: [],
    });
  });

  it('applies provided values', () => {
    const options = buildSweepOptions(
      {
        shapes: ' Alpha+Digits ,hex',
        'ignore-hosts': 'Shared-Mail.example',
        'mailbox-domains': 'Mail.Example.Com',
        'min-shared-key-kinds': '3',
        'max-domains-per-infra-key': '90',
        'min-user-key-share': '0.25',
      },
      defaults
    );
    expect(options).toMatchObject({
      localPartShapes: ['alpha+digits', 'hex'],
      ignoredInfrastructureHosts: ['shared-mail.example'],
      sharedMailboxDomains: ['example.com'],
      minSharedKeyKinds: 3,
      maxDomainsPerInfraKey: 90,
      minUserKeyShare: 0.25,
    });
  });

  it.each([
    ['min-user-key-share', '0'],
    ['min-user-key-share', '1.5'],
    ['min-shared-key-kinds', '0'],
    ['max-cohort-domains', '-1'],
    ['min-domains', 'two'],
    ['signup-bucket-hours', '1.5'],
  ])('rejects --%s %s', (flag, value) => {
    expect(() => buildSweepOptions({ [flag]: value }, defaults)).toThrow();
  });

  it('accepts any in any case, alone only', () => {
    expect(buildSweepOptions({ shapes: 'ANY' }, defaults).localPartShapes).toBe('any');
    expect(() => buildSweepOptions({ shapes: 'any,alpha' }, defaults)).toThrow(/cannot be combined/);
  });
});

describe('parseSignupSelection', () => {
  it('leaves omitted flags undefined', () => {
    expect(parseSignupSelection({})).toEqual({ since: undefined, until: undefined, maxUsers: undefined });
  });

  it('parses ISO dates and the user limit', () => {
    expect(
      parseSignupSelection({ since: '2026-03-01T00:00:00Z', until: '2026-04-01T00:00:00Z', 'max-users': '10' })
    ).toEqual({
      since: new Date('2026-03-01T00:00:00Z'),
      until: new Date('2026-04-01T00:00:00Z'),
      maxUsers: 10,
    });
  });

  it.each(['2026-03-01T00:00:00Z', '2026-02-28T00:00:00Z'])(
    'rejects an empty or reversed range ending at %s',
    until => {
      expect(() => parseSignupSelection({ since: '2026-03-01T00:00:00Z', until })).toThrow(
        '--since must be before --until'
      );
    }
  );

  it.each([
    ['since', 'notadate'],
    ['until', '2026-03-01'],
    ['max-users', '-1'],
    ['max-users', '0'],
  ])('rejects --%s %s', (flag, value) => {
    expect(() => parseSignupSelection({ [flag]: value })).toThrow();
  });
});
