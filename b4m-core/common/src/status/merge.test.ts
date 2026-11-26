import { describe, expect, it } from 'vitest';
import {
  NOW,
  isoSeconds,
  makeBreakglass,
  makeExternal,
  makeHead,
  makeIncident,
  makeProjectionInput,
  makeRuntime,
  makeSummary,
  minutesAgo,
} from './__fixtures__/statusFixtures';
import { projectPublicSnapshot } from './project';
import { clampBreakGlassEntry, mergeStatusSources, parseSourceFile } from './merge';
import type { PublicBreakglassEntry, PublicSummary } from './schemas.public';

const secondsAgo = (seconds: number) => isoSeconds(new Date(NOW.getTime() - seconds * 1000));

function summaryAged(ageSeconds: number, overrides: Partial<PublicSummary> = {}): PublicSummary {
  return makeSummary({ probesAsOf: secondsAgo(ageSeconds), ...overrides });
}

function comp(
  slug: string,
  overrides: Partial<PublicSummary['components'][number]> = {}
): PublicSummary['components'][number] {
  return { ...makeSummary().components[0], slug, name: slug, externallyMonitored: false, ...overrides };
}

function entry(overrides: Partial<PublicBreakglassEntry> = {}): PublicBreakglassEntry {
  return { ...makeHead({ id: 'bg00000001' }), writtenSeq: 13, journalNonce: 'n0nce000000000000001', ...overrides };
}

describe('source classification', () => {
  const good = JSON.stringify(makeSummary());

  it('accepts a valid summary', () => {
    expect(parseSourceFile('summary', { status: 200, body: good }).ok).toBe(true);
  });

  it.each<[string, { status: number; body: string } | null, string]>([
    ['absent', null, 'absent'],
    ['403', { status: 403, body: '{"error":"forbidden"}' }, 'http'],
    ['404', { status: 404, body: '' }, 'http'],
    ['5xx', { status: 503, body: good }, 'http'],
    ['HTML', { status: 200, body: '<!doctype html><html></html>' }, 'not_json'],
    ['schema-failing', { status: 200, body: JSON.stringify({ schemaVersion: 2 }) }, 'schema'],
    ['wrong shape', { status: 200, body: '[]' }, 'schema'],
  ])('%s is a failure', (_name, response, reason) => {
    expect(parseSourceFile('summary', response)).toEqual({ ok: false, reason });
  });

  it('parses leniently, stripping unknown keys', () => {
    const result = parseSourceFile('summary', { status: 200, body: JSON.stringify({ ...makeSummary(), extra: 1 }) });
    expect(result.ok && 'extra' in result.data).toBe(false);
  });
});

describe('summary unavailable', () => {
  it('is neutral, shows only break-glass incidents and a fresh external state', () => {
    const merged = mergeStatusSources(
      null,
      makeBreakglass([entry({ updatedAt: secondsAgo(30) })]),
      makeExternal(),
      NOW
    );
    expect(merged.mode).toBe('unavailable');
    expect(merged.headline).toEqual({ kind: 'unavailable', state: 'unknown', text: 'Status data unavailable' });
    expect(merged.components).toEqual([]);
    expect(merged.incidents.map(i => i.id)).toEqual(['bg00000001']);
    expect(merged.incidents[0].unreconciled).toBe(true);
    expect(merged.external?.state).toBe('up');
  });

  it('hides a stale external file', () => {
    const stale = makeExternal({ checkedAt: secondsAgo(181) });
    expect(mergeStatusSources(null, null, stale, NOW).external).toBeNull();
    expect(mergeStatusSources(null, null, makeExternal({ checkedAt: secondsAgo(180) }), NOW).external).not.toBeNull();
  });

  it('shows nothing at all with no sources', () => {
    const merged = mergeStatusSources(null, null, null, NOW);
    expect(merged.incidents).toEqual([]);
    expect(merged.external).toBeNull();
    expect(merged.headline.kind).toBe('unavailable');
  });

  it('offers the last good summary greyed, with its age', () => {
    const lastGood = { summary: makeSummary(), savedAt: secondsAgo(600) };
    const merged = mergeStatusSources(null, null, null, NOW, { lastGoodSummary: lastGood });
    expect(merged.lastKnown?.ageSeconds).toBe(600);
    expect(merged.components).toEqual([]);
    expect(mergeStatusSources(makeSummary(), null, null, NOW, { lastGoodSummary: lastGood }).lastKnown).toBeNull();
  });

  it('offers no last good summary when its savedAt cannot be parsed', () => {
    const lastGood = { summary: makeSummary(), savedAt: 'bad' };
    expect(mergeStatusSources(null, null, null, NOW, { lastGoodSummary: lastGood }).lastKnown).toBeNull();
  });
});

describe('freshness', () => {
  const components = [
    comp('web-app', { state: 'operational', baseState: 'operational' }),
    comp('chat', { state: 'partial_outage', baseState: 'partial_outage' }),
    comp('billing', { monitoring: 'manual', state: 'operational', baseState: 'operational' }),
  ];

  it('is fresh up to staleAfterSeconds inclusive', () => {
    expect(mergeStatusSources(summaryAged(240, { components }), null, null, NOW).mode).toBe('fresh');
    expect(mergeStatusSources(summaryAged(241, { components }), null, null, NOW).mode).toBe('stale');
  });

  it('fresh: headline is the worst visible state', () => {
    const merged = mergeStatusSources(summaryAged(30, { components }), null, null, NOW);
    expect(merged.headline).toEqual({ kind: 'state', state: 'partial_outage', text: null });
    expect(merged.components.every(c => c.staleAsOf === null)).toBe(true);
  });

  it('stale: delayed headline, never green, last known states labeled with their time', () => {
    const allGood = [comp('web-app'), comp('chat')];
    const merged = mergeStatusSources(summaryAged(300, { components: allGood }), null, null, NOW);
    expect(merged.headline.kind).toBe('delayed');
    expect(merged.headline.state).toBe('unknown');
    expect(merged.headline.text).toContain(secondsAgo(300));
    expect(merged.components.map(c => c.state)).toEqual(['operational', 'operational']);
    expect(merged.components.every(c => c.staleAsOf === secondsAgo(300))).toBe(true);
  });

  it('hard stale: probed rows become unknown, others keep their state', () => {
    const merged = mergeStatusSources(summaryAged(901, { components }), null, null, NOW);
    expect(merged.mode).toBe('hard_stale');
    expect(merged.hardStale).toBe(true);
    expect(Object.fromEntries(merged.components.map(c => [c.slug, c.state]))).toEqual({
      'web-app': 'unknown',
      chat: 'unknown',
      billing: 'operational',
    });
    expect(merged.headline.kind).toBe('delayed');
  });

  it('a probesAsOf far in the future is not fresh, a little skew is', () => {
    expect(mergeStatusSources(summaryAged(-600, { components }), null, null, NOW).fresh).toBe(false);
    expect(mergeStatusSources(summaryAged(-30, { components }), null, null, NOW).fresh).toBe(true);
  });

  it('an external checkedAt far in the future is not used', () => {
    expect(mergeStatusSources(null, null, makeExternal({ checkedAt: secondsAgo(-600) }), NOW).external).toBeNull();
    expect(mergeStatusSources(null, null, makeExternal({ checkedAt: secondsAgo(-30) }), NOW).external).not.toBeNull();
  });

  it('hard stale boundary is exclusive at 900 seconds', () => {
    expect(mergeStatusSources(summaryAged(900, { components }), null, null, NOW).hardStale).toBe(false);
  });

  it('uses the thresholds carried in the summary', () => {
    const merged = mergeStatusSources(
      summaryAged(100, { components, staleAfterSeconds: 60, hardStaleAfterSeconds: 90 }),
      null,
      null,
      NOW
    );
    expect(merged.mode).toBe('hard_stale');
  });

  it('an empty component list reads unknown, not operational', () => {
    const merged = mergeStatusSources(summaryAged(10, { components: [] }), null, null, NOW);
    expect(merged.headline).toEqual({ kind: 'state', state: 'unknown', text: null });
  });
});

describe('incidents', () => {
  it('an active incident-kind incident is a floor under the base state', () => {
    const summary = summaryAged(10, {
      components: [comp('chat', { state: 'degraded', baseState: 'degraded' })],
      activeIncidents: [makeHead({ components: [{ slug: 'chat', impact: 'major_outage' }] })],
    });
    expect(mergeStatusSources(summary, null, null, NOW).components[0].state).toBe('major_outage');
  });

  it('never masks a worse base state', () => {
    const summary = summaryAged(10, {
      components: [comp('chat', { state: 'major_outage', baseState: 'major_outage' })],
      activeIncidents: [makeHead({ components: [{ slug: 'chat', impact: 'degraded' }] })],
    });
    expect(mergeStatusSources(summary, null, null, NOW).components[0].state).toBe('major_outage');
  });

  it('a resolved incident no longer floors the state', () => {
    const summary = summaryAged(10, {
      components: [comp('chat')],
      activeIncidents: [
        makeHead({
          status: 'resolved',
          resolvedAt: secondsAgo(5),
          components: [{ slug: 'chat', impact: 'major_outage' }],
        }),
      ],
    });
    expect(mergeStatusSources(summary, null, null, NOW).components[0].state).toBe('operational');
  });

  it('incidents listing unknown slugs show in the list and the headline, not on rows', () => {
    const summary = summaryAged(10, {
      components: [comp('chat')],
      activeIncidents: [makeHead({ components: [{ slug: 'ghost', impact: 'major_outage' }] })],
    });
    const merged = mergeStatusSources(summary, null, null, NOW);
    expect(merged.incidents).toHaveLength(1);
    expect(merged.components[0].state).toBe('operational');
    expect(merged.headline).toEqual({ kind: 'state', state: 'partial_outage', text: null });
  });

  it('unions summary heads, the 90-day index and break-glass by id', () => {
    const head = makeHead({ id: 'sum0000001' });
    const indexRow = {
      ...makeHead({ id: 'idx0000001', status: 'resolved', resolvedAt: secondsAgo(500) }),
      latestUpdates: undefined,
    };
    const { latestUpdates: _l, ...row } = indexRow;
    const merged = mergeStatusSources(
      summaryAged(10, { activeIncidents: [head] }),
      makeBreakglass([entry({ id: 'bg00000002' })]),
      null,
      NOW,
      {
        incidentsIndex: {
          schemaVersion: 1,
          seq: 48210,
          generatedAt: isoSeconds(NOW),
          windowDays: 90,
          incidents: [row],
        },
      }
    );
    expect(merged.incidents.map(i => i.id).sort()).toEqual(['bg00000002', 'idx0000001', 'sum0000001']);
  });

  it('per id the newer updatedAt supplies the scalars', () => {
    const older = makeHead({ title: 'older', updatedAt: secondsAgo(300) });
    const newer = makeHead({ title: 'newer', status: 'monitoring', updatedAt: secondsAgo(100) });
    const merged = mergeStatusSources(
      summaryAged(10, { activeIncidents: [older], breakglassAppliedSeq: 0 }),
      makeBreakglass([{ ...newer, writtenSeq: 1, journalNonce: 'n0nce000000000000002' }]),
      null,
      NOW
    );
    expect(merged.incidents).toHaveLength(1);
    expect(merged.incidents[0]).toMatchObject({ title: 'newer', status: 'monitoring' });
  });

  it('unions updates by id; the same id takes the later editedAt', () => {
    const base = makeHead().latestUpdates[0];
    const fromSummary = makeHead({
      updatedAt: secondsAgo(200),
      latestUpdates: [
        { ...base, id: 'u_shared', body: 'old' },
        { ...base, id: 'u_only_summary', body: 's' },
      ],
    });
    const fromBreakglass = {
      ...makeHead({ updatedAt: secondsAgo(100), latestUpdates: [] }),
      latestUpdates: [
        { ...base, id: 'u_shared', body: 'corrected', edited: true, editedAt: secondsAgo(50) },
        { ...base, id: 'u_only_bg', body: 'b' },
      ],
      writtenSeq: 1,
      journalNonce: 'n0nce000000000000002',
    };
    const merged = mergeStatusSources(
      summaryAged(10, { activeIncidents: [fromSummary], breakglassAppliedSeq: 0 }),
      makeBreakglass([fromBreakglass]),
      null,
      NOW
    );
    const bodies = Object.fromEntries(merged.incidents[0].updates.map(u => [u.id, u.body]));
    expect(bodies).toEqual({ u_shared: 'corrected', u_only_summary: 's', u_only_bg: 'b' });
    expect(merged.incidents[0].updates.every(u => !('editedAt' in u))).toBe(true);
  });

  it('a published correction beats a stale break-glass copy of the same update', () => {
    const base = makeHead().latestUpdates[0];
    const corrected = makeHead({
      updatedAt: secondsAgo(20),
      latestUpdates: [{ ...base, id: 'u_shared', body: 'fixed text', edited: true }],
    });
    const stale = {
      ...makeHead({ updatedAt: secondsAgo(400), latestUpdates: [] }),
      latestUpdates: [{ ...base, id: 'u_shared', body: 'typo text' }],
      writtenSeq: 1,
      journalNonce: 'n0nce000000000000002',
    };
    const merged = mergeStatusSources(
      summaryAged(10, { activeIncidents: [corrected], breakglassAppliedSeq: 0 }),
      makeBreakglass([stale]),
      null,
      NOW
    );
    expect(merged.incidents[0].updates[0]).toMatchObject({ body: 'fixed text', edited: true });
  });

  it('a break-glass resolve, newer and above the applied seq, lifts the floor', () => {
    const open = makeHead({ updatedAt: secondsAgo(200), components: [{ slug: 'chat', impact: 'major_outage' }] });
    const resolved = {
      ...open,
      status: 'resolved' as const,
      resolvedAt: secondsAgo(60),
      updatedAt: secondsAgo(60),
      writtenSeq: 13,
      journalNonce: 'n0nce000000000000002',
    };
    const summary = summaryAged(10, { components: [comp('chat')], activeIncidents: [open], breakglassAppliedSeq: 12 });
    const merged = mergeStatusSources(summary, makeBreakglass([resolved]), null, NOW);
    expect(merged.components[0].state).toBe('operational');
    expect(merged.incidents[0].active).toBe(false);
  });
});

describe('outage start from unparseable timestamps', () => {
  it('ignores an unparseable external since when clamping an unreconciled entry', () => {
    const external = makeExternal({ state: 'down', since: '2026-13-01T00:00:00Z', checkedAt: secondsAgo(10) });
    const merged = mergeStatusSources(
      summaryAged(30),
      makeBreakglass([entry({ updatedAt: secondsAgo(30) })]),
      external,
      NOW
    );
    expect(merged.incidents.map(i => i.id)).toEqual(['bg00000001']);
  });

  it('ignores an unparseable summary probesAsOf when the summary is stale', () => {
    const summary = { ...summaryAged(10_000), probesAsOf: '2026-13-01T00:00:00Z' };
    const merged = mergeStatusSources(summary, makeBreakglass([entry({ updatedAt: secondsAgo(30) })]), null, NOW);
    expect(merged.incidents.map(i => i.id)).toEqual(['bg00000001']);
  });
});

describe('break-glass sequence and retraction', () => {
  const summary = (applied: number) => summaryAged(10, { breakglassAppliedSeq: applied });

  it('shows entries above the applied seq, drops those at or below it', () => {
    const entries = [
      entry({ id: 'bg00000012', writtenSeq: 12 }),
      entry({ id: 'bg00000013', writtenSeq: 13 }),
      entry({ id: 'bg00000011', writtenSeq: 11 }),
    ];
    const merged = mergeStatusSources(summary(12), makeBreakglass(entries), null, NOW);
    expect(merged.incidents.map(i => i.id)).toEqual(['bg00000013']);
    expect(merged.incidents[0].unreconciled).toBe(true);
  });

  it('a future-dated probesAsOf does not move an unreconciled entry start or set staleAsOf', () => {
    const entries = [entry({ id: 'bg00000013', writtenSeq: 13, startedAt: secondsAgo(3600) })];
    const base = mergeStatusSources(summaryAged(10, { breakglassAppliedSeq: 12 }), makeBreakglass(entries), null, NOW);
    const future = mergeStatusSources(
      summaryAged(-3600, { breakglassAppliedSeq: 12 }),
      makeBreakglass(entries),
      null,
      NOW
    );
    expect(future.incidents[0].startedAt).toBe(base.incidents[0].startedAt);
    expect(future.components.every(c => c.staleAsOf === null)).toBe(true);
  });

  it('a retraction after reconcile is not resurrected by the stale break-glass copy', () => {
    const merged = mergeStatusSources(summary(5), makeBreakglass([entry({ writtenSeq: 5 })]), null, NOW);
    expect(merged.incidents).toEqual([]);
  });

  it('every entry shows while no summary is available', () => {
    const merged = mergeStatusSources(
      null,
      makeBreakglass([entry({ writtenSeq: 1 }), entry({ id: 'bg00000009', writtenSeq: 2 })]),
      null,
      NOW
    );
    expect(merged.incidents).toHaveLength(2);
  });
});

describe('break-glass timestamp clamps', () => {
  const W = new Date(NOW.getTime() - 5 * 60_000);
  const context: { nowMs: number; outageStartMs: number | null } = { nowMs: NOW.getTime(), outageStartMs: null };

  const clamped = (overrides: Partial<PublicBreakglassEntry>, ctx = context) =>
    clampBreakGlassEntry(entry({ updatedAt: isoSeconds(W), ...overrides }), ctx)!;

  it('leaves in-range timestamps alone', () => {
    const update = { ...makeHead().latestUpdates[0], at: isoSeconds(W) };
    const startedAt = isoSeconds(new Date(W.getTime() - 10 * 60_000));
    const result = clamped({ startedAt, latestUpdates: [update] });
    expect(result.updatedAt).toBe(isoSeconds(W));
    expect(result.latestUpdates[0].at).toBe(isoSeconds(W));
    expect(result.startedAt).toBe(startedAt);
  });

  it('clamps update times into [W - 15 min, W + 60 s]', () => {
    const base = makeHead().latestUpdates[0];
    const result = clamped({
      latestUpdates: [
        { ...base, id: 'u_past', at: isoSeconds(new Date(W.getTime() - 3 * 3_600_000)) },
        { ...base, id: 'u_future', at: isoSeconds(new Date(W.getTime() + 3_600_000)) },
      ],
    });
    expect(result.latestUpdates[0].at).toBe(isoSeconds(new Date(W.getTime() - 15 * 60_000)));
    expect(result.latestUpdates[1].at).toBe(isoSeconds(new Date(W.getTime() + 60_000)));
  });

  it('never shows a time later than the server time plus 60 seconds', () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    const result = clamped({
      updatedAt: isoSeconds(future),
      latestUpdates: [{ ...makeHead().latestUpdates[0], at: isoSeconds(future) }],
    });
    expect(result.updatedAt).toBe(isoSeconds(new Date(NOW.getTime() + 60_000)));
    expect(result.latestUpdates[0].at).toBe(isoSeconds(new Date(NOW.getTime() + 60_000)));
  });

  it('with no outage evidence the outage start is W, so startedAt floors at W - 15 min', () => {
    const result = clamped({ startedAt: isoSeconds(new Date(W.getTime() - 10 * 24 * 3_600_000)) });
    expect(result.startedAt).toBe(isoSeconds(new Date(W.getTime() - 15 * 60_000)));
  });

  it('startedAt is never earlier than W - 24 h, however old the outage start is', () => {
    const outageStartMs = W.getTime() - 30 * 3_600_000;
    const result = clamped(
      { startedAt: isoSeconds(new Date(W.getTime() - 10 * 24 * 3_600_000)) },
      { nowMs: NOW.getTime(), outageStartMs }
    );
    expect(result.startedAt).toBe(isoSeconds(new Date(W.getTime() - 24 * 3_600_000)));
  });

  it('startedAt is no earlier than outageStart - 15 min', () => {
    const outageStartMs = W.getTime() - 2 * 3_600_000;
    const result = clamped(
      { startedAt: isoSeconds(new Date(W.getTime() - 20 * 3_600_000)) },
      { nowMs: NOW.getTime(), outageStartMs }
    );
    expect(result.startedAt).toBe(isoSeconds(new Date(outageStartMs - 15 * 60_000)));
  });

  it('drops an entry with an unparseable time', () => {
    expect(clampBreakGlassEntry(entry({ startedAt: 'nope' }), context)).toBeNull();
  });

  it('applies through the merge, using the stale summary probesAsOf as the outage start', () => {
    const probesAsOf = new Date(NOW.getTime() - 3_600_000);
    const backdated = entry({
      updatedAt: secondsAgo(60),
      startedAt: isoSeconds(new Date(NOW.getTime() - 20 * 3_600_000)),
    });
    const merged = mergeStatusSources(
      makeSummary({ probesAsOf: isoSeconds(probesAsOf), breakglassAppliedSeq: 0 }),
      makeBreakglass([backdated]),
      null,
      NOW
    );
    expect(merged.incidents[0].startedAt).toBe(isoSeconds(new Date(probesAsOf.getTime() - 15 * 60_000)));
  });

  it('uses E.since when external is down', () => {
    const since = new Date(NOW.getTime() - 2 * 3_600_000);
    const backdated = entry({
      updatedAt: secondsAgo(60),
      startedAt: isoSeconds(new Date(NOW.getTime() - 20 * 3_600_000)),
    });
    const merged = mergeStatusSources(
      summaryAged(10, { breakglassAppliedSeq: 0 }),
      makeBreakglass([backdated]),
      makeExternal({ state: 'down', since: isoSeconds(since) }),
      NOW
    );
    expect(merged.incidents[0].startedAt).toBe(isoSeconds(new Date(since.getTime() - 15 * 60_000)));
  });
});

describe('external check', () => {
  const monitored = [comp('web-app', { externallyMonitored: true }), comp('billing', { externallyMonitored: false })];
  const down = (overrides = {}) => makeExternal({ state: 'down', since: secondsAgo(600), ...overrides });
  const states = (merged: ReturnType<typeof mergeStatusSources>) =>
    Object.fromEntries(merged.components.map(c => [c.slug, c.state]));

  it('is ignored while the summary is fresh', () => {
    const merged = mergeStatusSources(summaryAged(30, { components: monitored }), null, down(), NOW);
    expect(states(merged)).toEqual({ 'web-app': 'operational', billing: 'operational' });
  });

  it('forces externally monitored rows to major outage when the summary is stale', () => {
    const merged = mergeStatusSources(summaryAged(300, { components: monitored }), null, down(), NOW);
    expect(states(merged)).toEqual({ 'web-app': 'major_outage', billing: 'operational' });
    expect(merged.headline.kind).toBe('delayed');
  });

  it('applies under a hard-stale summary too, over the unknown base', () => {
    const merged = mergeStatusSources(summaryAged(1_000, { components: monitored }), null, down(), NOW);
    expect(states(merged)['web-app']).toBe('major_outage');
  });

  it('does nothing when the external state is up or unknown', () => {
    for (const state of ['up', 'unknown'] as const) {
      const merged = mergeStatusSources(
        summaryAged(300, { components: monitored }),
        null,
        makeExternal({ state }),
        NOW
      );
      expect(states(merged)['web-app']).toBe('operational');
    }
  });

  it('ignores a stale external file', () => {
    const merged = mergeStatusSources(
      summaryAged(300, { components: monitored }),
      null,
      down({ checkedAt: secondsAgo(181) }),
      NOW
    );
    expect(states(merged)['web-app']).toBe('operational');
  });

  it('honours externalIgnoredUntil from the summary', () => {
    const summary = summaryAged(300, {
      components: monitored,
      externalIgnoredUntil: isoSeconds(new Date(NOW.getTime() + 60_000)),
    });
    expect(states(mergeStatusSources(summary, null, down(), NOW))['web-app']).toBe('operational');
    const expired = summaryAged(300, { components: monitored, externalIgnoredUntil: secondsAgo(1) });
    expect(states(mergeStatusSources(expired, null, down(), NOW))['web-app']).toBe('major_outage');
  });

  it('honours a break-glass external override above the applied seq until it expires', () => {
    const override = (writtenSeq: number, until: Date) =>
      makeBreakglass([], { externalOverride: { writtenSeq, ignoreUntil: isoSeconds(until) } });
    const summary = summaryAged(300, { components: monitored, breakglassAppliedSeq: 12 });
    const future = new Date(NOW.getTime() + 3_600_000);
    expect(states(mergeStatusSources(summary, override(13, future), down(), NOW))['web-app']).toBe('operational');
    expect(states(mergeStatusSources(summary, override(13, new Date(NOW.getTime() - 1)), down(), NOW))['web-app']).toBe(
      'major_outage'
    );
    expect(states(mergeStatusSources(summary, override(12, future), down(), NOW))['web-app']).toBe('major_outage');
  });

  it('exposes the usable external state, and none when overridden', () => {
    const summary = summaryAged(10, { components: monitored, breakglassAppliedSeq: 0 });
    expect(mergeStatusSources(summary, null, down(), NOW).external?.state).toBe('down');
    const overridden = makeBreakglass([], {
      externalOverride: { writtenSeq: 1, ignoreUntil: isoSeconds(new Date(NOW.getTime() + 60_000)) },
    });
    expect(mergeStatusSources(summary, overridden, down(), NOW).external).toBeNull();
  });
});

describe('maintenance', () => {
  const window = (startMin: number, endMin: number, slug = 'web-app') =>
    makeHead({
      id: 'mnt0000001',
      kind: 'maintenance',
      status: 'scheduled',
      impact: 'none',
      components: [{ slug, impact: 'degraded' }],
      scheduledStartAt: isoSeconds(new Date(NOW.getTime() + startMin * 60_000)),
      scheduledEndAt: isoSeconds(new Date(NOW.getTime() + endMin * 60_000)),
      updatedAt: secondsAgo(3_000),
    });
  const base = (overrides: Partial<PublicSummary>) =>
    summaryAged(10, { components: [comp('web-app'), comp('chat')], ...overrides });

  it('labels a component from the schedule alone, without changing its state', () => {
    const merged = mergeStatusSources(base({ upcomingMaintenance: [window(-10, 50)] }), null, null, NOW);
    const row = merged.components[0];
    expect(row.maintenance).toEqual({
      incidentId: 'mnt0000001',
      endsAt: isoSeconds(new Date(NOW.getTime() + 50 * 60_000)),
    });
    expect(row.state).toBe('operational');
  });

  it('does not label before the window or after its effective end', () => {
    expect(
      mergeStatusSources(base({ upcomingMaintenance: [window(10, 70)] }), null, null, NOW).components[0].maintenance
    ).toBeNull();
    expect(
      mergeStatusSources(base({ upcomingMaintenance: [window(-70, -10)] }), null, null, NOW).components[0].maintenance
    ).toBeNull();
  });

  it('a window that started after the summary was generated is still found', () => {
    const merged = mergeStatusSources(
      summaryAged(200, { components: [comp('web-app')], upcomingMaintenance: [window(-1, 30)] }),
      null,
      null,
      NOW
    );
    expect(merged.mode).toBe('fresh');
    expect(merged.components[0].maintenance).not.toBeNull();
  });

  it('shows the label with a stale summary and external down, state from the external check', () => {
    const summary = summaryAged(300, {
      components: [comp('web-app', { externallyMonitored: true })],
      upcomingMaintenance: [window(-10, 50)],
    });
    const merged = mergeStatusSources(summary, null, makeExternal({ state: 'down', since: secondsAgo(600) }), NOW);
    expect(merged.components[0].maintenance).not.toBeNull();
    expect(merged.components[0].state).toBe('major_outage');
    expect(merged.headline.kind).toBe('delayed');
  });

  it('headline reads Maintenance in progress when every non-operational row is under a label', () => {
    const summary = summaryAged(10, {
      components: [comp('web-app', { state: 'major_outage', baseState: 'major_outage' }), comp('chat')],
      upcomingMaintenance: [window(-10, 50)],
    });
    const merged = mergeStatusSources(summary, null, null, NOW);
    expect(merged.headline).toEqual({ kind: 'maintenance', state: 'major_outage', text: 'Maintenance in progress' });
    expect(merged.components[0].state).toBe('major_outage');
  });

  it('headline stays a state when a non-operational row has no label', () => {
    const summary = summaryAged(10, {
      components: [comp('web-app'), comp('chat', { state: 'degraded', baseState: 'degraded' })],
      upcomingMaintenance: [window(-10, 50)],
    });
    expect(mergeStatusSources(summary, null, null, NOW).headline.kind).toBe('state');
  });

  it('a cancelled window labels nothing', () => {
    const cancelled = { ...window(-10, 50), status: 'cancelled' as const };
    expect(
      mergeStatusSources(base({ upcomingMaintenance: [cancelled] }), null, null, NOW).components[0].maintenance
    ).toBeNull();
  });

  it('maintenance never feeds the state floor', () => {
    const merged = mergeStatusSources(base({ upcomingMaintenance: [window(-10, 50)] }), null, null, NOW);
    expect(merged.components[0].state).toBe('operational');
  });
});

describe('notice', () => {
  it('passes the offline notice through', () => {
    const merged = mergeStatusSources(
      summaryAged(10, { overall: { state: 'operational', notice: 'offline' } }),
      null,
      null,
      NOW
    );
    expect(merged.notice).toBe('offline');
    expect(mergeStatusSources(null, null, null, NOW).notice).toBeNull();
  });
});

describe('children', () => {
  it('applies base and incident rules to child rows', () => {
    const { group: _group, children: _children, ...childRow } = comp('sign-in-google');
    const parent = comp('sign-in', { children: [childRow] });
    const merged = mergeStatusSources(summaryAged(1_000, { components: [parent] }), null, null, NOW);
    expect(merged.components[0].state).toBe('unknown');
    expect(merged.components[0].children[0].state).toBe('unknown');
  });

  it('floors a child row with an active incident listing its slug', () => {
    const { group: _group, children: _children, ...childRow } = comp('sign-in-google');
    const parent = comp('sign-in', { children: [childRow] });
    const summary = summaryAged(10, {
      components: [parent],
      activeIncidents: [makeHead({ components: [{ slug: 'sign-in-google', impact: 'partial_outage' }] })],
    });
    const merged = mergeStatusSources(summary, null, null, NOW);
    expect(merged.components[0].children[0].state).toBe('partial_outage');
    expect(merged.headline).toEqual({ kind: 'state', state: 'partial_outage', text: null });
  });
});

describe('summary rows survive a size-ladder cut', () => {
  const count = 21;
  const key = (n: number) => `comp-${String(n).padStart(2, '0')}`;
  const snapshot = projectPublicSnapshot(
    makeProjectionInput({
      summarySizeCap: 2_000,
      components: Array.from({ length: count }, (_, n) =>
        makeRuntime({ component: { key: key(n), publicSlug: key(n), name: key(n), order: n } })
      ),
      incidents: Array.from({ length: count }, (_, n) =>
        makeIncident({
          publicId: `i${String(n).padStart(9, '0')}`,
          impact: 'critical',
          components: [{ componentKey: key(n), impact: 'major_outage' }],
          updatedAt: minutesAgo(5),
        })
      ),
    })
  );
  const stateOf = (merged: ReturnType<typeof mergeStatusSources>, slug: string) =>
    merged.components.find(c => c.slug === slug)?.state;

  it('cuts the last incident head but publishes its component as down', () => {
    expect(snapshot.summary.moreActiveIncidents).toBe(1);
    expect(snapshot.summary.activeIncidents).toHaveLength(20);
    expect(snapshot.summary.components.find(c => c.slug === 'comp-20')?.state).toBe('major_outage');
  });

  it('keeps the published state when no incidents index covers the missing head', () => {
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW);
    expect(stateOf(merged, 'comp-20')).toBe('major_outage');
    expect(stateOf(merged, 'comp-00')).toBe('major_outage');
  });

  it('lets an incidents index that lists the head decide instead', () => {
    const resolved = snapshot.incidentsIndex.incidents.map(row =>
      row.id === 'i000000020' ? { ...row, status: 'resolved' as const, resolvedAt: isoSeconds(minutesAgo(1)) } : row
    );
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW, {
      incidentsIndex: { ...snapshot.incidentsIndex, seq: snapshot.summary.seq + 1, incidents: resolved },
    });
    expect(stateOf(merged, 'comp-20')).toBe('operational');
  });

  it('keeps a published maintenance label when the head that explains it was cut', () => {
    const maintenance = { incidentId: 'mt00000001', endsAt: isoSeconds(minutesAgo(-30)) };
    const row = comp('web-app', { state: 'degraded', maintenance });
    const cut = makeSummary({ components: [row], moreActiveIncidents: 1 });
    expect(mergeStatusSources(cut, null, null, NOW).components[0].maintenance).toEqual(maintenance);
    const whole = makeSummary({ components: [row], moreActiveIncidents: 0 });
    expect(mergeStatusSources(whole, null, null, NOW).components[0].maintenance).toBeNull();
  });

  it('does not floor when no head was cut', () => {
    const summary = makeSummary({ components: [comp('web-app', { state: 'major_outage', baseState: 'operational' })] });
    expect(stateOf(mergeStatusSources(summary, null, null, NOW), 'web-app')).toBe('operational');
  });
});

describe('break-glass update choice', () => {
  const written = (minutesBefore: number) => isoSeconds(new Date(NOW.getTime() - minutesBefore * 60_000));
  const bgUpdate = (overrides: Partial<PublicBreakglassEntry['latestUpdates'][number]>) => ({
    ...makeHead().latestUpdates[0],
    id: 'u_shared',
    ...overrides,
  });
  const bodies = (entries: PublicBreakglassEntry[], summary: PublicSummary | null = null) =>
    mergeStatusSources(summary, makeBreakglass(entries), null, NOW).incidents[0].updates.map(u => u.body);

  const older = entry({
    id: 'bg00000002',
    updatedAt: written(10),
    latestUpdates: [bgUpdate({ at: written(12), editedAt: '2099-01-01T00:00:00Z', body: 'far future edit' })],
  });
  const newer = entry({
    id: 'bg00000002',
    updatedAt: written(2),
    latestUpdates: [bgUpdate({ at: written(12), editedAt: written(1), body: 'real edit' })],
  });

  it('clamps editedAt like at, so a far-future edit cannot win', () => {
    const result = clampBreakGlassEntry(older, { nowMs: NOW.getTime(), outageStartMs: null });
    expect(result?.latestUpdates[0].editedAt).toBe(isoSeconds(new Date(NOW.getTime() - 9 * 60_000)));
    expect(bodies([older, newer])).toEqual(['real edit']);
  });

  it('gives the same result for either entry order', () => {
    expect(bodies([older, newer])).toEqual(bodies([newer, older]));
    const tied = [
      entry({ id: 'bg00000003', updatedAt: written(3), latestUpdates: [bgUpdate({ body: 'zzz', at: written(4) })] }),
      entry({ id: 'bg00000003', updatedAt: written(3), latestUpdates: [bgUpdate({ body: 'aaa', at: written(4) })] }),
    ];
    expect(bodies(tied)).toEqual(bodies([...tied].reverse()));
  });

  it('prefers the trusted summary copy on a full tie', () => {
    const at = written(4);
    const summaryHead = makeHead({
      id: 'bg00000004',
      updatedAt: written(3),
      latestUpdates: [{ ...makeHead().latestUpdates[0], id: 'u_shared', at, body: 'from summary' }],
    });
    const fromBreakglass = entry({
      id: 'bg00000004',
      updatedAt: written(3),
      latestUpdates: [bgUpdate({ at, body: 'from break-glass' })],
    });
    expect(bodies([fromBreakglass], makeSummary({ activeIncidents: [summaryHead] }))).toEqual(['from summary']);
  });
});

describe('break-glass timestamp bounds', () => {
  const context = { nowMs: NOW.getTime(), outageStartMs: null };
  const far = '2099-01-01T00:00:00Z';
  const fresh = (overrides: Partial<PublicBreakglassEntry>) =>
    clampBreakGlassEntry(entry({ updatedAt: isoSeconds(NOW), ...overrides }), context)!;
  const limit = (ms: number) => isoSeconds(new Date(NOW.getTime() + ms));

  it('never lets startedAt, resolvedAt or completedEarlyAt be in the future', () => {
    const result = fresh({ startedAt: far, resolvedAt: far, completedEarlyAt: far });
    expect(result.startedAt).toBe(limit(60_000));
    expect(result.resolvedAt).toBe(limit(60_000));
    expect(result.completedEarlyAt).toBe(limit(60_000));
  });

  it('bounds the maintenance schedule to 30 days ahead and keeps absent values null', () => {
    const result = fresh({ kind: 'maintenance', status: 'scheduled', scheduledStartAt: far, scheduledEndAt: far });
    expect(result.scheduledStartAt).toBe(limit(30 * 24 * 3_600_000));
    expect(result.scheduledEndAt).toBe(limit(30 * 24 * 3_600_000));
    const near = limit(2 * 3_600_000);
    expect(fresh({ scheduledStartAt: near }).scheduledStartAt).toBe(near);
    expect(fresh({}).resolvedAt).toBeNull();
  });

  it('rejects an entry whose optional timestamp cannot be parsed', () => {
    expect(clampBreakGlassEntry(entry({ resolvedAt: '2026-13-45T00:00:00Z' }), context)).toBeNull();
  });

  it('rejects an entry with an unparseable updatedAt, startedAt, update at or update editedAt', () => {
    const bad = '2026-13-45T00:00:00Z';
    const update = makeHead().latestUpdates[0];
    expect(clampBreakGlassEntry(entry({ updatedAt: bad }), context)).toBeNull();
    expect(clampBreakGlassEntry(entry({ startedAt: bad }), context)).toBeNull();
    expect(clampBreakGlassEntry(entry({ latestUpdates: [{ ...update, at: bad }] }), context)).toBeNull();
    expect(clampBreakGlassEntry(entry({ latestUpdates: [{ ...update, editedAt: bad }] }), context)).toBeNull();
  });

  it('leaves an entry with an unparseable timestamp out of the merge instead of throwing', () => {
    const update = makeHead().latestUpdates[0];
    const merged = mergeStatusSources(
      makeSummary(),
      makeBreakglass([
        entry({ id: 'bg00000002', latestUpdates: [{ ...update, at: '2026-13-45T00:00:00Z' }] }),
        entry({ id: 'bg00000003', updatedAt: '2026-13-45T00:00:00Z' }),
      ]),
      null,
      NOW
    );
    expect(merged.incidents.map(i => i.id)).not.toContain('bg00000002');
    expect(merged.incidents.map(i => i.id)).not.toContain('bg00000003');
  });

  describe('external override window', () => {
    const state = (ignoreUntil: string, now: Date, updatedAt = new Date(NOW.getTime() - 60_000)) => {
      const summary = makeSummary({
        components: [comp('web-app', { externallyMonitored: true })],
        probesAsOf: isoSeconds(new Date(now.getTime() - 300_000)),
        breakglassAppliedSeq: 12,
      });
      const external = makeExternal({
        state: 'down',
        since: isoSeconds(new Date(now.getTime() - 3_600_000)),
        checkedAt: isoSeconds(new Date(now.getTime() - 10_000)),
      });
      const breakglass = makeBreakglass([], {
        updatedAt: isoSeconds(updatedAt),
        externalOverride: { writtenSeq: 13, ignoreUntil },
      });
      return mergeStatusSources(summary, breakglass, external, now).components[0].state;
    };
    const after = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

    it('lasts at most 24 hours from when it was written, whatever ignoreUntil says', () => {
      expect(state(far, NOW)).toBe('operational');
      expect(state(far, after(23))).toBe('operational');
      expect(state(far, after(25))).toBe('major_outage');
    });
  });
});

describe('break-glass file with a bad entry', () => {
  const body = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
    status: 200,
    body: JSON.stringify({ ...makeBreakglass(), entries, ...overrides }),
  });
  const bad = entry({
    id: 'bg00000005',
    latestUpdates: [{ ...makeHead().latestUpdates[0], body: 'x'.repeat(4_001) }],
  });

  it('drops only the failing entry and reports how many', () => {
    const result = parseSourceFile('breakglass', body([entry(), bad, { nonsense: true }]));
    expect(result.ok && result.data.entries.map(e => e.id)).toEqual(['bg00000001']);
    expect(result.ok && result.droppedEntries).toBe(2);
  });

  it('keeps every entry when all parse', () => {
    const result = parseSourceFile('breakglass', body([entry(), entry({ id: 'bg00000006' })]));
    expect(result.ok && result.droppedEntries).toBe(0);
    expect(result.ok && result.data.entries).toHaveLength(2);
  });

  it('still rejects a broken envelope', () => {
    expect(parseSourceFile('breakglass', body([entry()], { schemaVersion: 2 }))).toEqual({
      ok: false,
      reason: 'schema',
    });
    expect(parseSourceFile('breakglass', body([entry()], { entries: 'nope' }))).toEqual({
      ok: false,
      reason: 'schema',
    });
  });

  it('reports zero dropped entries for other files', () => {
    const result = parseSourceFile('summary', { status: 200, body: JSON.stringify(makeSummary()) });
    expect(result.ok && result.droppedEntries).toBe(0);
  });
});

describe('headline for an incident that touches no component on the page', () => {
  const rows = { components: [comp('web-app'), comp('chat')] };
  const noComponents = (overrides: Parameters<typeof makeHead>[0] = {}) =>
    makeHead({ id: 'bg00000020', impact: 'critical', components: [], ...overrides });

  it('a break-glass incident with no components raises a fresh headline', () => {
    const summary = summaryAged(10, { ...rows, breakglassAppliedSeq: 12 });
    const merged = mergeStatusSources(summary, makeBreakglass([entry(noComponents())]), null, NOW);
    expect(merged.headline).toEqual({ kind: 'state', state: 'major_outage', text: null });
    expect(merged.components.every(row => row.state === 'operational')).toBe(true);
  });

  it('an incident that lists a component on the page adds nothing beyond the row', () => {
    const head = noComponents({ components: [{ slug: 'chat', impact: 'degraded' }] });
    const merged = mergeStatusSources(summaryAged(10, { ...rows, activeIncidents: [head] }), null, null, NOW);
    expect(merged.headline.state).toBe('degraded');
  });

  it('a resolved incident or a maintenance without components adds nothing', () => {
    const resolved = noComponents({ id: 'res0000001', status: 'resolved', resolvedAt: secondsAgo(60) });
    const maintenance = noComponents({
      id: 'mnt0000002',
      kind: 'maintenance',
      status: 'in_progress',
      scheduledStartAt: secondsAgo(600),
      scheduledEndAt: isoSeconds(new Date(NOW.getTime() + 3_600_000)),
    });
    const summary = summaryAged(10, { ...rows, activeIncidents: [maintenance, resolved] });
    expect(mergeStatusSources(summary, null, null, NOW).headline.state).toBe('operational');
  });

  it('the maintenance headline gives way when an uncovered incident raised the state', () => {
    const window = makeHead({
      id: 'mnt0000001',
      kind: 'maintenance',
      status: 'in_progress',
      impact: 'none',
      components: [{ slug: 'web-app', impact: 'degraded' }],
      scheduledStartAt: secondsAgo(600),
      scheduledEndAt: isoSeconds(new Date(NOW.getTime() + 3_600_000)),
      updatedAt: secondsAgo(3_000),
    });
    const pinned = comp('web-app', { state: 'degraded', baseState: 'degraded' });
    const summary = (extra: PublicSummary['activeIncidents']) =>
      summaryAged(10, { components: [pinned], activeIncidents: [window, ...extra] });
    expect(mergeStatusSources(summary([]), null, null, NOW).headline.kind).toBe('maintenance');
    const raised = mergeStatusSources(summary([noComponents({ id: 'inc0000001' })]), null, null, NOW).headline;
    expect(raised).toEqual({ kind: 'state', state: 'major_outage', text: null });
  });
});
