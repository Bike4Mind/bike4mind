import { describe, expect, it } from 'vitest';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

import {
  BREADTH_GATE_PATHS,
  PROBE_QUERY,
  actorsOverThreshold,
  groupProbeActors,
  parseProbeRows,
  scoreRow,
  type ProbeRow,
  type ProbeSignalCounts,
} from './apiProbeScoring';

const counts = (overrides: Partial<ProbeSignalCounts> = {}): ProbeSignalCounts => ({
  refusedFetch: 0,
  webhookSignature: 0,
  invalidId: 0,
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
