import { describe, expect, it } from 'vitest';
import { orgFeedbackSummaryArtifactSchema } from './OrgFeedbackSummaryTypes';

/** An artifact of the shape already sitting in S3, written before `byTagTruncated` existed. */
const STORED_ARTIFACT = {
  summaryJobId: 'job-1',
  organizationId: 'org-1',
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  generatedAt: '2026-02-01T00:00:00.000Z',
  model: 'a-model',
  summary: 'Two reports, both about billing.',
  counts: {
    totals: { count: 2 },
    byDay: [{ day: '2026-01-10', count: 2 }],
    bySubject: [{ key: 'product', count: 2 }],
    byType: [{ key: 'Bug', count: 2 }],
    byStatus: [{ key: 'New', count: 2 }],
    byTag: [{ key: 'billing', count: 2 }],
  },
};

/**
 * The read route re-parses whatever is in the bucket and raises a parse failure as a 500, so a
 * required `byTagTruncated` would turn every artifact written before it into a server error.
 */
describe('orgFeedbackSummaryArtifactSchema', () => {
  it('parses a stored artifact that carries no byTagTruncated', () => {
    const parsed = orgFeedbackSummaryArtifactSchema.parse(STORED_ARTIFACT);

    expect(parsed.counts.byTagTruncated).toBeUndefined();
    expect(parsed.counts.byTag).toEqual([{ key: 'billing', count: 2 }]);
  });

  it('keeps the flag when a newer artifact carries it', () => {
    const parsed = orgFeedbackSummaryArtifactSchema.parse({
      ...STORED_ARTIFACT,
      counts: { ...STORED_ARTIFACT.counts, byTagTruncated: true },
    });

    expect(parsed.counts.byTagTruncated).toBe(true);
  });
});
