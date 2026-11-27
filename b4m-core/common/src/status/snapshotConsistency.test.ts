import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOW,
  makeBreakglass,
  makeHead,
  makeIncident,
  makeProjectionInput,
  makeRichInput,
  makeRuntime,
  minutesAgo,
} from './__fixtures__/statusFixtures';
import { projectPublicSnapshot } from './project';
import { mergeStatusSources } from './merge';
import * as markdown from './markdown';
import { PublicSummarySchema, PublicUptimeSchema } from './schemas.public';
import { formatUptimePercent } from './uptimeDisplay';
import { TEXT_LIMITS } from './types';

const day = (value: string) => ({
  day: value,
  barCode: 'o' as const,
  uptimeBp: 10_000,
  downtimeMinutes: 0,
  incidentIds: [],
});
const row = (componentKey: string, uptime: number | null, dates: string[]) => ({
  componentKey,
  uptime,
  days: dates.map(day),
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('calendar-aligned uptime snapshots', () => {
  it('distinguishes different calendar histories with identical per-component observations', () => {
    const publish = (chat: string, signIn: string) =>
      projectPublicSnapshot(makeRichInput({ uptime: [row('chat', 1, [chat]), row('sign-in', 1, [signIn])] })).uptime;
    const first = publish('2026-11-22', '2026-11-23');
    const swapped = publish('2026-11-23', '2026-11-22');
    expect(first).not.toEqual(swapped);
    expect(first.components.find(value => value.slug === 'chat')?.days).toEqual([
      ['o', 10_000, 0, 0],
      ['n', null, 0, 0],
    ]);
  });

  it('fills an interior missing date without shifting the next observation', () => {
    const uptime = projectPublicSnapshot(
      makeProjectionInput({ uptime: [row('chat', 1, ['2026-11-20', '2026-11-22'])] })
    ).uptime;
    expect(uptime.components[0].days).toEqual([
      ['o', 10_000, 0, 0],
      ['n', null, 0, 0],
      ['o', 10_000, 0, 0],
    ]);
  });

  it('derives the range only from accepted rows', () => {
    const uptime = projectPublicSnapshot(
      makeRichInput({ uptime: [row('chat', 1, ['2026-11-23']), row('sign-in', NaN, ['2026-11-01'])] })
    ).uptime;
    expect(uptime.components.map(value => value.slug)).toEqual(['chat']);
    expect(uptime.from).toBe('2026-11-23');
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite uptime fraction %s', uptime => {
    expect(
      projectPublicSnapshot(makeProjectionInput({ uptime: [row('chat', uptime, ['2026-11-23'])] })).uptime.components
    ).toEqual([]);
  });

  it.each([{ dates: ['2026-09-31'] }, { dates: ['2026-11-23', '2026-11-23'] }])(
    'rejects impossible or duplicate calendar dates $dates',
    ({ dates }) => {
      expect(projectPublicSnapshot(makeProjectionInput({ uptime: [row('chat', 1, dates)] })).uptime.components).toEqual(
        []
      );
    }
  );

  it('preserves a fraction already on the five-decimal display grid', () => {
    const uptime = projectPublicSnapshot(makeProjectionInput({ uptime: [row('chat', 0.0003, [])] })).uptime
      .components[0].uptime;
    expect(uptime).toBe(0.0003);
    expect(formatUptimePercent(uptime)).toBe('0.03%');
  });

  it('rejects calendar overflow in public timestamps and day bounds', () => {
    const snapshot = projectPublicSnapshot(makeProjectionInput());
    expect(PublicSummarySchema.safeParse({ ...snapshot.summary, generatedAt: '2026-02-30T00:00:00Z' }).success).toBe(
      false
    );
    expect(PublicUptimeSchema.safeParse({ ...snapshot.uptime, from: '2026-02-30' }).success).toBe(false);
  });
});

describe('source revision and maintenance consistency', () => {
  it('does not resurrect an old unresolved incident against a newer empty summary', () => {
    const previous = projectPublicSnapshot(makeProjectionInput({ seq: 1, incidents: [makeIncident()] }));
    const current = projectPublicSnapshot(makeProjectionInput({ seq: 2 }));
    const merged = mergeStatusSources(current.summary, null, null, NOW, { incidentsIndex: previous.incidentsIndex });
    expect(merged.incidents.some(value => value.active)).toBe(false);
    expect(merged.headline.state).toBe('operational');
  });

  it('does not clear a size-ladder outage using an unrelated historical-only index', () => {
    const key = (index: number) => `comp-${String(index).padStart(2, '0')}`;
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        seq: 2,
        summarySizeCap: 2_000,
        components: Array.from({ length: 21 }, (_, index) =>
          makeRuntime({ component: { key: key(index), publicSlug: key(index), name: key(index), order: index } })
        ),
        incidents: Array.from({ length: 21 }, (_, index) =>
          makeIncident({
            publicId: `i${String(index).padStart(9, '0')}`,
            impact: 'critical',
            components: [{ componentKey: key(index), impact: 'major_outage' }],
            updatedAt: minutesAgo(5),
          })
        ),
      })
    );
    expect(snapshot.summary.moreActiveIncidents).toBe(1);
    const previous = projectPublicSnapshot(
      makeProjectionInput({
        seq: 1,
        incidents: [
          makeIncident({ publicId: 'h000000001', status: 'resolved', resolvedAt: minutesAgo(1), updates: [] }),
        ],
      })
    );
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW, { incidentsIndex: previous.incidentsIndex });
    expect(merged.components.find(value => value.slug === 'comp-20')?.state).toBe('major_outage');
  });

  it.each(['completed', 'scheduled'] as const)('excludes already-ended future maintenance with status %s', status => {
    const incident = makeIncident({
      kind: 'maintenance',
      status,
      scheduledStartAt: minutesAgo(-120),
      scheduledEndAt: minutesAgo(-180),
      completedEarlyAt: minutesAgo(30),
      updates: [],
    });
    const snapshot = projectPublicSnapshot(makeProjectionInput({ incidents: [incident] }));
    expect(snapshot.incidentFiles[incident.publicId]).toBeDefined();
    expect(snapshot.summary.upcomingMaintenance).toEqual([]);
  });
});

describe('public markdown preserves ordered meaning and bounded work', () => {
  const options = { linkHosts: ['app.example.com'] };
  it('preserves the start of an ordered list through all renderings', () => {
    const parsed = markdown.parseMarkdown('3. Restore service\n4. Confirm recovery', options);
    expect(markdown.renderMarkdownHtml(parsed)).toBe(
      '<ol start="3"><li>Restore service</li><li>Confirm recovery</li></ol>'
    );
    expect(markdown.renderMarkdownText(parsed)).toBe('3. Restore service\n4. Confirm recovery');
    expect(markdown.sanitizeMarkdown('3. Restore service', options)).toBe('3. Restore service');
  });

  it('does not turn a year inside a paragraph into a list starting at one', () => {
    const parsed = markdown.parseMarkdown('Requests failed in\n2024. Restore service.', options);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('paragraph');
    expect(markdown.renderMarkdownText(parsed)).toContain('2024. Restore service.');
  });

  it('bounds the input sent to the real sanitizer for an over-limit update', () => {
    const sanitizer = vi.spyOn(markdown, 'sanitizeMarkdown');
    const incident = makeIncident();
    incident.updates[0].body = 'A'.repeat(200_000);
    const snapshot = projectPublicSnapshot(makeProjectionInput({ incidents: [incident] }));
    expect(snapshot.incidentFiles[incident.publicId].incident.updates[0].truncated).toBe(true);
    expect(sanitizer).toHaveBeenCalled();
    expect(Math.max(...sanitizer.mock.calls.map(args => args[0].length))).toBeLessThanOrEqual(
      TEXT_LIMITS.updateBody * 4
    );
  });
});

describe('complete index authority', () => {
  const publish = (seq: number, incidents = [makeIncident()]) =>
    projectPublicSnapshot(makeProjectionInput({ seq, incidents }));

  it('binds both envelopes to the same logical revision, even within one timestamp', () => {
    const first = publish(1);
    const next = publish(2, []);
    expect(next.summary.generatedAt).toBe(first.summary.generatedAt);
    expect(next.incidentsIndex.seq).toBe(next.summary.seq);
    const merged = mergeStatusSources(first.summary, null, null, NOW, { incidentsIndex: next.incidentsIndex });
    expect(merged.incidents).toEqual([]);
    expect(merged.headline.state).toBe('operational');
  });

  it('takes newer resolution scalars even when incident update timestamps tie, keeping summary bodies', () => {
    const first = publish(1);
    const next = publish(2, [makeIncident({ status: 'resolved', resolvedAt: minutesAgo(1), updates: [] })]);
    expect(next.incidentsIndex.incidents[0].updatedAt).toBe(first.summary.activeIncidents[0].updatedAt);
    const merged = mergeStatusSources(first.summary, null, null, NOW, { incidentsIndex: next.incidentsIndex });
    expect(merged.incidents[0].status).toBe('resolved');
    expect(merged.incidents[0].active).toBe(false);
    expect(merged.incidents[0].updates[0].body).toBe(first.summary.activeIncidents[0].latestUpdates[0].body);
    expect(merged.headline.state).toBe('operational');
  });

  it('does not let an older history row overwrite an active summary row with the same ID', () => {
    const current = publish(2);
    const old = publish(1, [makeIncident({ status: 'resolved', resolvedAt: minutesAgo(1) })]);
    expect(
      mergeStatusSources(current.summary, null, null, NOW, { incidentsIndex: old.incidentsIndex }).incidents[0].active
    ).toBe(true);
  });

  it('fails closed for a same-revision index missing or contradicting a known head', () => {
    const snapshot = publish(2);
    for (const incidents of [[], [{ ...snapshot.incidentsIndex.incidents[0], title: 'Different title' }]]) {
      const merged = mergeStatusSources(snapshot.summary, null, null, NOW, {
        incidentsIndex: { ...snapshot.incidentsIndex, incidents },
      });
      expect(merged.incidents[0].title).toBe(snapshot.summary.activeIncidents[0].title);
      expect(merged.incidents[0].active).toBe(true);
    }
  });

  it('fails closed for future, duplicate or malformed envelopes', () => {
    const snapshot = publish(2);
    const newer = publish(3, []);
    const indexes = [
      { ...newer.incidentsIndex, generatedAt: '2030-01-01T00:00:00Z' },
      { ...newer.incidentsIndex, seq: Number.NaN },
      {
        ...snapshot.incidentsIndex,
        seq: 3,
        incidents: [snapshot.incidentsIndex.incidents[0], snapshot.incidentsIndex.incidents[0]],
      },
    ];
    for (const incidentsIndex of indexes) {
      expect(mergeStatusSources(snapshot.summary, null, null, NOW, { incidentsIndex }).incidents[0].active).toBe(true);
    }
  });

  it('retains automatic outages when a newer empty index retracts every incident', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        seq: 2,
        components: [makeRuntime({ automaticState: 'major_outage' })],
        incidents: [makeIncident()],
      })
    );
    const newer = publish(3, []);
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW, { incidentsIndex: newer.incidentsIndex });
    expect(merged.incidents).toEqual([]);
    expect(merged.headline.state).toBe('major_outage');
  });

  it('does not acknowledge an emergency entry merely because the complete index omits it', () => {
    const snapshot = publish(2, []);
    const emergency = makeBreakglass([{ ...makeHead(), writtenSeq: snapshot.summary.breakglassAppliedSeq + 1 }]);
    const newer = publish(3, []);
    const merged = mergeStatusSources(snapshot.summary, emergency, null, NOW, { incidentsIndex: newer.incidentsIndex });
    expect(merged.incidents[0].active).toBe(true);
    expect(merged.incidents[0].unreconciled).toBe(true);
    const applied = mergeStatusSources(
      { ...snapshot.summary, breakglassAppliedSeq: emergency.entries[0].writtenSeq },
      emergency,
      null,
      NOW,
      { incidentsIndex: newer.incidentsIndex }
    );
    expect(applied.incidents).toEqual([]);
  });

  it('keeps the headline unavailable without a summary', () => {
    const snapshot = publish(2);
    const merged = mergeStatusSources(null, null, null, NOW, { incidentsIndex: snapshot.incidentsIndex });
    expect(merged.headline.kind).toBe('unavailable');
    expect(merged.components).toEqual([]);
  });
});

describe('calendar and markdown boundary preservation', () => {
  it('aligns leap days and ignores observations beyond the UTC window', () => {
    const now = new Date('2024-03-01T00:01:00Z');
    const uptime = projectPublicSnapshot(
      makeProjectionInput({ now, uptime: [row('chat', 1, ['2023-01-01', '2024-02-28', '2024-03-01', '2024-03-02'])] })
    ).uptime;
    expect(uptime.from).toBe('2024-02-28');
    expect(uptime.to).toBe('2024-03-01');
    expect(uptime.components[0].days).toEqual([
      ['o', 10_000, 0, 0],
      ['n', null, 0, 0],
      ['o', 10_000, 0, 0],
    ]);
  });

  it('pads accepted empty rows to the default 90-day window', () => {
    const uptime = projectPublicSnapshot(makeProjectionInput({ uptime: [row('chat', null, [])] })).uptime;
    expect(uptime.components[0].days).toHaveLength(90);
    expect(uptime.components[0].days.every(value => JSON.stringify(value) === '["n",null,0,0]')).toBe(true);
  });

  it('preserves large ordered starts through the sanitizer fixed point', () => {
    const source = '999999999. first\n1. second';
    const sanitized = markdown.sanitizeMarkdown(source, { linkHosts: [] });
    expect(markdown.parseMarkdown(sanitized, { linkHosts: [] })).toEqual(
      markdown.parseMarkdown(source, { linkHosts: [] })
    );
    expect(markdown.sanitizeMarkdown(sanitized, { linkHosts: [] })).toBe(sanitized);
    expect(markdown.renderMarkdownText(markdown.parseMarkdown(sanitized, { linkHosts: [] }))).toBe(
      '999999999. first\n1000000000. second'
    );
  });

  it('preserves separate numbered steps and inner links after an unclosed outer link', () => {
    const steps = '1. First\n\nExplanation\n\n2. Second\n\n3. Third';
    expect(
      markdown.renderMarkdownText(
        markdown.parseMarkdown(markdown.sanitizeMarkdown(steps, { linkHosts: [] }), { linkHosts: [] })
      )
    ).toBe(steps);
    const parsed = markdown.parseMarkdown('[a](x [b](https://app.example.com/y)', { linkHosts: ['app.example.com'] });
    expect(markdown.renderMarkdownHtml(parsed)).toContain('href="https://app.example.com/y"');
  });

  it('keeps a valid future maintenance window while dropping cancellation', () => {
    const future = makeIncident({
      kind: 'maintenance',
      status: 'scheduled',
      scheduledStartAt: minutesAgo(-120),
      scheduledEndAt: minutesAgo(-180),
      updates: [],
    });
    expect(
      projectPublicSnapshot(makeProjectionInput({ incidents: [future] })).summary.upcomingMaintenance
    ).toHaveLength(1);
    expect(
      projectPublicSnapshot(makeProjectionInput({ incidents: [{ ...future, status: 'cancelled' }] })).summary
        .upcomingMaintenance
    ).toEqual([]);
  });
});

describe('truncated summary completeness', () => {
  const publish = () => {
    const key = (index: number) => `comp-${String(index).padStart(2, '0')}`;
    return projectPublicSnapshot(
      makeProjectionInput({
        seq: 2,
        summarySizeCap: 2_000,
        components: Array.from({ length: 21 }, (_, index) =>
          makeRuntime({ component: { key: key(index), publicSlug: key(index), name: key(index), order: index } })
        ),
        incidents: Array.from({ length: 21 }, (_, index) =>
          makeIncident({
            publicId: `i${String(index).padStart(9, '0')}`,
            impact: 'critical',
            components: [{ componentKey: key(index), impact: 'major_outage' }],
            updatedAt: minutesAgo(5),
          })
        ),
      })
    );
  };

  it('recovers omitted heads only from the complete matching revision', () => {
    const snapshot = publish();
    expect(snapshot.summary.moreActiveIncidents).toBe(1);
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW, { incidentsIndex: snapshot.incidentsIndex });
    expect(merged.incidents.filter(value => value.active)).toHaveLength(21);
    expect(merged.components.find(value => value.slug === 'comp-20')?.state).toBe('major_outage');
    const incomplete = { ...snapshot.incidentsIndex, incidents: snapshot.incidentsIndex.incidents.slice(1) };
    const fallback = mergeStatusSources(snapshot.summary, null, null, NOW, { incidentsIndex: incomplete });
    expect(fallback.components.find(value => value.slug === 'comp-20')?.state).toBe('major_outage');
  });

  it('can clear all incident floors using a newer complete empty revision', () => {
    const snapshot = publish();
    const merged = mergeStatusSources(snapshot.summary, null, null, NOW, {
      incidentsIndex: { ...snapshot.incidentsIndex, seq: 3, incidents: [] },
    });
    expect(merged.incidents).toEqual([]);
    expect(merged.components.every(value => value.state === 'operational')).toBe(true);
  });

  it('projects an oversized malformed-link update with bounded sanitizer input and valid public output', () => {
    const sanitizer = vi.spyOn(markdown, 'sanitizeMarkdown');
    const incident = makeIncident();
    incident.updates[0].body = '[a]('.repeat(50_000);
    const snapshot = projectPublicSnapshot(makeProjectionInput({ incidents: [incident] }));
    const update = snapshot.incidentFiles[incident.publicId].incident.updates[0];
    expect(update.truncated).toBe(true);
    expect(update.body.length).toBeLessThanOrEqual(TEXT_LIMITS.updateBody);
    expect(Math.max(...sanitizer.mock.calls.map(args => args[0].length))).toBeLessThanOrEqual(
      TEXT_LIMITS.updateBody * 4
    );
    expect(snapshot.summary.activeIncidents).toHaveLength(1);
  });
});
