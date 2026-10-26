import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COHORT_CSV_COLUMNS, parseDomainFactsFile, renderCohortCsv } from './signupCohortSweep';

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
