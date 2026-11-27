import { describe, expect, it } from 'vitest';
import { makeHead, makeSummary, isoSeconds, NOW, minutesAgo } from './__fixtures__/statusFixtures';
import { parseMarkdown, renderMarkdownHtml } from './markdown';
import type { PublicIncidentHead, PublicIncidentIndexRow } from './schemas.public';
import {
  STATUS_FILE_SIZE_CAPS,
  SUMMARY_LADDER,
  applySummarySizeLadder,
  checkFileSize,
  fitIncidentIndex,
  jsonByteLength,
  utf8ByteLength,
  type StatusFileSizeKey,
} from './sizeLadder';

const impacts = ['minor', 'major', 'critical', 'none'] as const;

function bigHead(index: number, overrides: Partial<PublicIncidentHead> = {}): PublicIncidentHead {
  const id = `a${String(index).padStart(9, '0')}`;
  return makeHead({
    id,
    impact: impacts[index % impacts.length],
    updatedAt: isoSeconds(minutesAgo(index)),
    updateCount: 5,
    latestUpdates: Array.from({ length: 5 }, (_, n) => ({
      id: `u_${index}_${n}`,
      at: isoSeconds(minutesAgo(index + n)),
      status: 'identified' as const,
      body: `${'x'.repeat(1_500)} ${n}`,
      edited: false,
      truncated: false,
    })),
    ...overrides,
  });
}

function bigSummary() {
  const upcoming = Array.from({ length: 8 }, (_, n) =>
    bigHead(100 + n, {
      kind: 'maintenance',
      status: 'scheduled',
      impact: 'none',
      scheduledStartAt: isoSeconds(new Date(NOW.getTime() + (8 - n) * 3_600_000)),
      scheduledEndAt: isoSeconds(new Date(NOW.getTime() + (9 - n) * 3_600_000)),
    })
  );
  return makeSummary({
    activeIncidents: Array.from({ length: 30 }, (_, n) => bigHead(n)),
    upcomingMaintenance: upcoming,
  });
}

describe('summary ladder', () => {
  const summary = bigSummary();
  const full = jsonByteLength(summary);

  it('leaves a summary under the cap untouched', () => {
    const small = makeSummary({ activeIncidents: [makeHead()] });
    const result = applySummarySizeLadder(small);
    expect(result.appliedSteps).toEqual([]);
    expect(result.summary).toBe(small);
    expect(result.overCap).toBe(false);
  });

  it('steps through the ladder in order as the cap shrinks', () => {
    const seen = new Map<string, number>();
    for (let cap = full; cap >= 0; cap -= 4001) {
      const key = applySummarySizeLadder(summary, cap).appliedSteps.join(',');
      if (!seen.has(key)) seen.set(key, cap);
    }
    expect([...seen.keys()]).toEqual(['', '1', '1,2', '1,2,3', '1,2,3,4', '1,2,3,4,5']);
  });

  it('applies each step at its own cap', () => {
    const capFor = (steps: string) => {
      for (let cap = full; cap >= 0; cap -= 1499) {
        if (applySummarySizeLadder(summary, cap).appliedSteps.join(',') === steps) return cap;
      }
      throw new Error(`no cap reaches ${steps}`);
    };

    const step1 = applySummarySizeLadder(summary, capFor('1')).summary;
    for (const head of step1.activeIncidents) {
      expect(head.latestUpdates.length).toBeLessThanOrEqual(SUMMARY_LADDER.latestUpdates[0]);
      for (const update of head.latestUpdates) expect(Array.from(update.body).length).toBeLessThanOrEqual(1_000);
    }
    expect(step1.activeIncidents[0].latestUpdates[0].truncated).toBe(true);

    const step2 = applySummarySizeLadder(summary, capFor('1,2')).summary;
    for (const head of step2.activeIncidents) expect(head.latestUpdates).toHaveLength(1);
    expect(step2.activeIncidents[0].latestUpdates[0].body.length).toBeGreaterThan(280);

    const step3 = applySummarySizeLadder(summary, capFor('1,2,3')).summary;
    for (const head of step3.activeIncidents) {
      expect(Array.from(head.latestUpdates[0].body).length).toBeLessThanOrEqual(280);
      expect(head.latestUpdates[0].truncated).toBe(true);
    }

    const step4 = applySummarySizeLadder(summary, capFor('1,2,3,4')).summary;
    expect(step4.upcomingMaintenance).toHaveLength(5);
    expect(step4.activeIncidents).toHaveLength(30);
    const starts = step4.upcomingMaintenance.map(head => head.scheduledStartAt);
    expect(starts).toEqual([...starts].sort());
    expect(step4.upcomingMaintenance[0].id).toBe('a000000107');
  });

  it('step 5 keeps the 20 most severe active incidents and counts the rest', () => {
    const result = applySummarySizeLadder(summary, 1);
    expect(result.appliedSteps).toEqual([1, 2, 3, 4, 5]);
    expect(result.summary.activeIncidents).toHaveLength(SUMMARY_LADDER.maxActiveIncidents);
    expect(result.summary.moreActiveIncidents).toBe(10);
    const kept = new Set(result.summary.activeIncidents.map(head => head.id));
    const critical = summary.activeIncidents.filter(head => head.impact === 'critical');
    for (const head of critical) expect(kept.has(head.id)).toBe(true);
    const order = ['critical', 'major', 'minor', 'none'];
    const ranks = result.summary.activeIncidents.map(head => order.indexOf(head.impact));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('adds to an existing moreActiveIncidents count', () => {
    const result = applySummarySizeLadder({ ...summary, moreActiveIncidents: 4 }, 1);
    expect(result.summary.moreActiveIncidents).toBe(14);
  });

  it('never refuses: it reports over-cap and still returns a summary', () => {
    const result = applySummarySizeLadder(summary, 10);
    expect(result.overCap).toBe(true);
    expect(result.summary.components).toEqual(summary.components);
  });

  it('is deterministic and does not mutate its input', () => {
    const before = JSON.stringify(summary);
    expect(JSON.stringify(applySummarySizeLadder(summary, 20_000))).toBe(
      JSON.stringify(applySummarySizeLadder(summary, 20_000))
    );
    expect(JSON.stringify(summary)).toBe(before);
  });
});

describe('index ladder', () => {
  const row = (n: number, status: PublicIncidentIndexRow['status']): PublicIncidentIndexRow => {
    const { latestUpdates: _l, ...scalars } = makeHead({
      id: `b${String(n).padStart(9, '0')}`,
      status,
      title: `Incident ${n} ${'t'.repeat(40)}`,
      startedAt: isoSeconds(minutesAgo(1_000 - n)),
    });
    return scalars;
  };
  const measure = (rows: PublicIncidentIndexRow[]) => jsonByteLength(rows);

  it('keeps everything when it fits', () => {
    const rows = [row(1, 'resolved'), row(2, 'investigating')];
    expect(fitIncidentIndex(rows, measure, 1_000_000)).toEqual({ rows, dropped: 0, overCap: false });
  });

  it('drops the oldest resolved rows first and never an unresolved one', () => {
    const rows = [
      row(1, 'investigating'),
      row(2, 'resolved'),
      row(3, 'resolved'),
      row(4, 'resolved'),
      row(5, 'monitoring'),
    ];
    const cap = measure(rows) - 1;
    const fitted = fitIncidentIndex(rows, measure, cap);
    expect(fitted.dropped).toBe(1);
    expect(fitted.rows.map(r => r.id)).toEqual([rows[0].id, rows[2].id, rows[3].id, rows[4].id]);

    const tight = fitIncidentIndex(rows, measure, 1);
    expect(tight.rows.map(r => r.status)).toEqual(['investigating', 'monitoring']);
    expect(tight.overCap).toBe(true);
  });
});

describe('file caps', () => {
  const expected: Record<StatusFileSizeKey, number> = {
    summary: 64 * 1024,
    incidents: 256 * 1024,
    incident: 1024 * 1024,
    incidentHtml: 16 * 1024,
    archive: 512 * 1024,
    uptime: 256 * 1024,
    feed: 256 * 1024,
    statusJson: 2 * 1024,
    breakglass: 128 * 1024,
    external: 1024,
  };

  it.each(Object.entries(expected))('%s is capped at %i bytes', (key, cap) => {
    expect(STATUS_FILE_SIZE_CAPS[key as StatusFileSizeKey]).toBe(cap);
    expect(checkFileSize(key as StatusFileSizeKey, 'x'.repeat(cap))).toMatchObject({ bytes: cap, withinCap: true });
    expect(checkFileSize(key as StatusFileSizeKey, 'x'.repeat(cap + 1)).withinCap).toBe(false);
  });

  it('measures UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('\u00e9')).toBe(2);
    expect(utf8ByteLength('\u{1F600}')).toBe(4);
    expect(checkFileSize('external', '\u00e9'.repeat(513)).withinCap).toBe(false);
  });
});

describe('summary ladder truncation', () => {
  it('step 3 never leaves a cut markdown token in a body', () => {
    const body = `${'a'.repeat(250)} **bold text** and [status page](https://app.example.com/x) tail`;
    const heads = Array.from({ length: 30 }, (_, n) =>
      bigHead(n, {
        latestUpdates: [
          { id: `u_${n}`, at: isoSeconds(minutesAgo(n)), status: 'identified', body, edited: false, truncated: false },
        ],
      })
    );
    const result = applySummarySizeLadder(makeSummary({ activeIncidents: heads }), 1);
    for (const head of result.summary.activeIncidents) {
      const out = head.latestUpdates[0].body;
      expect(Array.from(out).length).toBeLessThanOrEqual(280);
      expect(out.endsWith('\u2026')).toBe(true);
      expect(renderMarkdownHtml(parseMarkdown(out, { linkHosts: ['app.example.com'] }))).not.toMatch(/\*|\[|\]\(/);
    }
  });
});
