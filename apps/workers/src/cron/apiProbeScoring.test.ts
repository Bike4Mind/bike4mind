import { describe, expect, it } from 'vitest';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

import {
  ADMIN_DENIED_PATH_PATTERN,
  ADMIN_GATE_PATHS,
  BREADTH_GATE_PATHS,
  PROBE_QUERY,
  REQUEST_PATH_PATTERN,
  actorsOverThreshold,
  groupProbeActors,
  parseProbeRows,
  scoreRow,
  type ProbeRow,
  type ProbeSignalCounts,
} from './apiProbeScoring';
import { INGEST_TOKEN_REFUSED_MESSAGE } from '@server/security/ingestToken';

const counts = (overrides: Partial<ProbeSignalCounts> = {}): ProbeSignalCounts => ({
  refusedFetch: 0,
  webhookSignature: 0,
  invalidId: 0,
  ingestTokenRefused: 0,
  adminDenied: 0,
  denied: 0,
  notFound: 0,
  ...overrides,
});

const row = (overrides: Partial<ProbeRow> = {}): ProbeRow => ({
  ip: '203.0.113.10',
  userId: null,
  counts: counts(),
  distinctPaths: 1,
  samplePaths: ['/api/example'],
  ...overrides,
});

const raw = (fields: Record<string, string>): ResultField[] =>
  Object.entries(fields).map(([field, value]) => ({ field, value }));

describe('PROBE_QUERY', () => {
  it('matches the error handler status lines by their escaped arrow', () => {
    expect(PROBE_QUERY).toContain('strcontains(message, "\u2192 400: Refusing to fetch")');
    expect(PROBE_QUERY).toContain('strcontains(message, "\u2192 404:")');
    expect(PROBE_QUERY).toContain('strcontains(message, "[cast-id-remap]")');
    expect(PROBE_QUERY).toContain('by ip, uid');
  });

  const PARSE_PREFIX = 'parse message /';
  const parseRegexBodies = () =>
    PROBE_QUERY.split('\n| ')
      .filter(line => line.startsWith(PARSE_PREFIX) && line.endsWith('/'))
      .map(line => line.slice(PARSE_PREFIX.length, -1));

  // Logs Insights ends a `/regex/` literal at the first unescaped `/` and rejects the rest of the line.
  it('escapes every slash inside a parse regex literal', () => {
    const bodies = parseRegexBodies();
    expect(bodies).toHaveLength(PROBE_QUERY.split('\n| ').filter(line => line.startsWith('parse ')).length);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toMatch(/(^|[^\\])(\\\\)*\//);
  });

  it('keeps the named capture groups and their matches in the escaped parse literals', () => {
    const [requestPath, adminDenied] = parseRegexBodies().map(body => new RegExp(body));
    const line = 'GET /api/admin/users/64f0c2a9 \u2192 403: Forbidden';
    expect(requestPath.exec(line)?.groups?.reqPath).toBe('/api/admin/users/64f0c2a9');
    expect(adminDenied.exec(line)?.groups?.adminDeniedPath).toBe('/api/admin/users');
  });

  it('counts breadth over the parsed request path, not the normalized path field', () => {
    expect(parseRegexBodies()[0]).toContain('(?<reqPath>');
    expect(PROBE_QUERY).toContain('count_distinct(reqPath) as paths');
    expect(PROBE_QUERY).not.toMatch(/\((path)\)/);
  });

  it.each([
    ['GET /api/admin \u2192 404: Not found', '/api/admin'],
    ['GET /api/.env \u2192 404: Not found', '/api/.env'],
    ['GET /api/notebooks?_=1712345678 \u2192 401: Unauthorized', '/api/notebooks'],
    ['POST /api/files/abc/share?x=1&y=2 \u2192 403: Forbidden', '/api/files/abc/share'],
  ])('extracts the request path from %s', (message, expected) => {
    expect(new RegExp(REQUEST_PATH_PATTERN).exec(message)?.groups?.reqPath).toBe(expected);
  });

  it('extracts nothing from lines that are not error handler status lines', () => {
    expect(new RegExp(REQUEST_PATH_PATTERN).exec('Stripe webhook signature verification failed')).toBeNull();
    expect(new RegExp(REQUEST_PATH_PATTERN).exec('[cast-id-remap] GET /api/x')).toBeNull();
  });

  it('captures the path of a denied admin request only', () => {
    const adminPath = (line: string) => new RegExp(ADMIN_DENIED_PATH_PATTERN).exec(line)?.groups?.adminDeniedPath;
    expect(adminPath('GET /api/admin/users \u2192 403: Forbidden')).toBe('/api/admin/users');
    expect(adminPath('POST /api/admin/system-secrets/x \u2192 401: Unauthorized')).toBe('/api/admin/system-secrets/x');
    expect(adminPath('GET /api/admin/users/65a1b2c3d4e5f6a7b8c9d0e1/credits \u2192 403: Forbidden')).toBe(
      '/api/admin/users'
    );
    expect(adminPath('GET /api/admin/sessions/0f8e2a4c-1b3d-4e5f-9a7b-2c4d6e8f0a1b?x=1 \u2192 401: No')).toBe(
      '/api/admin/sessions'
    );
    expect(adminPath('GET /api/admin/users \u2192 404: Not found')).toBeUndefined();
    expect(adminPath('GET /api/users \u2192 403: Forbidden')).toBeUndefined();
  });

  it('counts refused ingest tokens by the exact line the ingest routes write', () => {
    expect(PROBE_QUERY).toContain(`strcontains(message, "${INGEST_TOKEN_REFUSED_MESSAGE}")`);
    expect(PROBE_QUERY).toContain('count_distinct(adminDeniedPath) as adminDenied');
  });

  it('never aliases an aggregate to the field it sums, which Logs Insights returns empty', () => {
    for (const [, field, alias] of PROBE_QUERY.matchAll(/sum\((\w+)\) as (\w+)/g)) {
      expect(alias).not.toBe(field);
    }
  });
});

describe('parseProbeRows', () => {
  it('reads counts, breadth and deduplicated sample paths', () => {
    const [parsed] = parseProbeRows([
      raw({
        ip: '203.0.113.10',
        uid: 'user-a',
        refusedFetch: '2',
        notFound: '7',
        paths: '12',
        firstPath: '/api/a',
        lastPath: '/api/a',
      }),
    ]);
    expect(parsed).toEqual({
      ip: '203.0.113.10',
      userId: 'user-a',
      counts: counts({ refusedFetch: 2, notFound: 7 }),
      distinctPaths: 12,
      samplePaths: ['/api/a'],
    });
  });

  it('treats the empty-string placeholders as absent and drops rows with neither identifier', () => {
    const parsed = parseProbeRows([raw({ ip: '', uid: 'user-a' }), raw({ ip: '', uid: '' })]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ ip: null, userId: 'user-a' });
  });

  it('reads malformed or negative counts as zero', () => {
    const [parsed] = parseProbeRows([raw({ ip: '203.0.113.10', denied: 'NaN', notFound: '-3' })]);
    expect(parsed.counts).toEqual(counts());
  });
});

describe('scoreRow', () => {
  it('weighs refused fetches, webhook signature failures and invalid ids at any breadth', () => {
    expect(scoreRow({ counts: counts({ refusedFetch: 1, webhookSignature: 1, invalidId: 1 }), distinctPaths: 1 })).toBe(
      17
    );
  });

  it('ignores 401/403/404 from a narrow pair, such as an expired session polling a few routes', () => {
    expect(scoreRow({ counts: counts({ denied: 80, notFound: 20 }), distinctPaths: BREADTH_GATE_PATHS - 1 })).toBe(0);
  });

  it('counts 401/403/404 once the pair reaches the breadth gate', () => {
    expect(scoreRow({ counts: counts({ denied: 8, notFound: 22 }), distinctPaths: BREADTH_GATE_PATHS })).toBe(30);
  });

  it('weighs refused ingest tokens at any breadth', () => {
    expect(scoreRow({ counts: counts({ ingestTokenRefused: 3 }), distinctPaths: 1 })).toBe(15);
  });

  it('ignores denied admin routes below the gate, such as a page polling a few of them', () => {
    expect(scoreRow({ counts: counts({ adminDenied: ADMIN_GATE_PATHS - 1 }), distinctPaths: 1 })).toBe(0);
  });

  it('scores each distinct denied admin route once the gate is reached', () => {
    expect(scoreRow({ counts: counts({ adminDenied: 13 }), distinctPaths: 13 })).toBe(39);
  });

  it('gives breadth alone no score, so a busy legitimate user stays quiet', () => {
    expect(scoreRow({ counts: counts({ notFound: 1 }), distinctPaths: 200 })).toBe(1);
  });
});

describe('groupProbeActors', () => {
  it('joins an account and every IP it scored from into one actor', () => {
    const actors = groupProbeActors([
      row({ ip: '203.0.113.10', userId: 'user-a', counts: counts({ refusedFetch: 2 }) }),
      row({ ip: '198.51.100.7', userId: 'user-a', counts: counts({ invalidId: 5 }), samplePaths: ['/api/b'] }),
      row({ ip: '198.51.100.7', userId: null, counts: counts({ webhookSignature: 3 }), samplePaths: ['/api/c'] }),
    ]);
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({
      ips: ['198.51.100.7', '203.0.113.10'],
      userIds: ['user-a'],
      score: 20 + 10 + 15,
      counts: counts({ refusedFetch: 2, invalidId: 5, webhookSignature: 3 }),
      samplePaths: ['/api/b', '/api/c', '/api/example'],
    });
  });

  it('does not pull quiet users of a shared IP into a noisy neighbour', () => {
    const actors = groupProbeActors([
      row({ ip: '192.0.2.1', userId: 'user-noisy', counts: counts({ refusedFetch: 3 }) }),
      row({ ip: '192.0.2.1', userId: 'user-quiet', counts: counts({ notFound: 2 }), distinctPaths: 3 }),
    ]);
    expect(actors).toHaveLength(1);
    expect(actors[0].userIds).toEqual(['user-noisy']);
  });

  it('keeps unrelated actors apart, highest score first', () => {
    const actors = groupProbeActors([
      row({ ip: '192.0.2.1', counts: counts({ invalidId: 1 }) }),
      row({ ip: '192.0.2.2', userId: 'user-b', counts: counts({ refusedFetch: 1 }) }),
    ]);
    expect(actors.map(actor => actor.score)).toEqual([10, 2]);
  });

  it('chains through shared identifiers transitively', () => {
    const actors = groupProbeActors([
      row({ ip: '192.0.2.1', userId: 'user-a', counts: counts({ invalidId: 1 }) }),
      row({ ip: '192.0.2.2', userId: 'user-a', counts: counts({ invalidId: 1 }) }),
      row({ ip: '192.0.2.2', userId: 'user-b', counts: counts({ invalidId: 1 }) }),
    ]);
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ ips: ['192.0.2.1', '192.0.2.2'], userIds: ['user-a', 'user-b'], score: 6 });
  });

  it("scores each linked account on its own rows, so a co-tenant's share stays visible", () => {
    const [actor] = groupProbeActors([
      row({ ip: '192.0.2.1', userId: 'user-attacker', counts: counts({ refusedFetch: 3 }) }),
      row({ ip: '192.0.2.1', userId: 'user-cotenant', counts: counts({ invalidId: 1 }) }),
      row({ ip: '192.0.2.9', userId: 'user-attacker', counts: counts({ invalidId: 2 }) }),
    ]);
    expect(actor.score).toBe(36);
    expect(actor.userScores).toEqual({ 'user-attacker': 34, 'user-cotenant': 2 });
  });
});

describe('actorsOverThreshold', () => {
  it('reports actors at or above the threshold only', () => {
    const actors = groupProbeActors([
      row({ ip: '192.0.2.1', counts: counts({ refusedFetch: 2, invalidId: 2 }) }),
      row({ ip: '192.0.2.2', counts: counts({ refusedFetch: 2, invalidId: 3 }) }),
      row({ ip: '192.0.2.3', counts: counts({ refusedFetch: 2, invalidId: 1 }) }),
    ]);
    expect(actorsOverThreshold(actors, 24).map(actor => actor.ips[0])).toEqual(['192.0.2.2', '192.0.2.1']);
  });
});
