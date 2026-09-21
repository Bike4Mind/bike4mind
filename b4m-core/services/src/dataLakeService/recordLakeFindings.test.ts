import { describe, it, expect, vi } from 'vitest';
import type { InconsistencyFinding } from '@bike4mind/common';
import { EVIDENCE_MAX, LAKE_FINDING_SOURCE_MAX } from '@bike4mind/common';
import { recordLakeFindings } from './recordLakeFindings';

const SEEN_AT = new Date('2026-09-21T00:00:00Z');

const finding = (overrides: Partial<InconsistencyFinding> = {}): InconsistencyFinding => ({
  kind: 'metric-disagreement',
  subject: 'annual revenue usd',
  evidence: [
    { fabFileId: 'file-a', fileName: 'a.md', excerpt: 'revenue was 4M' },
    { fabFileId: 'file-b', fileName: 'b.md', excerpt: 'revenue was 7M' },
  ],
  documentCount: 2,
  ...overrides,
});

const adapters = (recordDetected = vi.fn().mockResolvedValue({})) => ({
  db: { dataLakeFindings: { recordDetected } },
  logger: { error: vi.fn(), warn: vi.fn() } as never,
});

describe('recordLakeFindings', () => {
  it('records each finding against the lake with the run detector and clock', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});

    const result = await recordLakeFindings(
      'lake-1',
      [finding(), finding({ subject: 'headcount' })],
      { detector: 'lexical', seenAt: SEEN_AT },
      adapters(recordDetected)
    );

    expect(result).toEqual({ recorded: 2, failed: 0 });
    expect(recordDetected).toHaveBeenCalledTimes(2);
    expect(recordDetected).toHaveBeenNthCalledWith(1, {
      lakeId: 'lake-1',
      kind: 'metric-disagreement',
      subject: 'annual revenue usd',
      detector: 'lexical',
      sources: [
        { fabFileId: 'file-a', fileName: 'a.md', excerpt: 'revenue was 4M' },
        { fabFileId: 'file-b', fileName: 'b.md', excerpt: 'revenue was 7M' },
      ],
      documentCount: 2,
      seenAt: SEEN_AT,
    });
  });

  it('stamps every finding in one run with the SAME instant', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});

    await recordLakeFindings(
      'lake-1',
      [finding({ subject: 'a' }), finding({ subject: 'b' }), finding({ subject: 'c' })],
      { detector: 'lexical', seenAt: SEEN_AT },
      adapters(recordDetected)
    );

    // "Everything this pass still saw" has to be one instant. Were the clock read per finding, rows
    // from a single run would differ by the write latency and no reader could group them.
    const stamps = new Set(recordDetected.mock.calls.map(([arg]) => arg.seenAt.getTime()));
    expect(stamps.size).toBe(1);
  });

  it('carries the detector through, so the reading pass is distinguishable', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});

    await recordLakeFindings('lake-1', [finding()], { detector: 'model', seenAt: SEEN_AT }, adapters(recordDetected));

    expect(recordDetected.mock.calls[0][0].detector).toBe('model');
  });

  it('keeps the storage cap aligned with the detector-report cap', async () => {
    // Two constants on purpose (see LAKE_FINDING_SOURCE_MAX), but they were tied together by
    // nothing but a comment - so raising one for its own reason would silently either truncate a
    // report the detector meant to store whole, or persist more excerpts per row than the size
    // measurement behind EVIDENCE_MAX allows for. This is the tie.
    expect(LAKE_FINDING_SOURCE_MAX).toBe(EVIDENCE_MAX);
  });

  it('caps stored sources regardless of what a producer supplies', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});
    const oversized = finding({
      evidence: Array.from({ length: LAKE_FINDING_SOURCE_MAX + 5 }, (_, i) => ({
        fabFileId: `file-${i}`,
        fileName: `${i}.md`,
        excerpt: 'x',
      })),
    });

    await recordLakeFindings('lake-1', [oversized], { detector: 'model', seenAt: SEEN_AT }, adapters(recordDetected));

    // The lexical detector already caps at its own EVIDENCE_MAX, so this is asserting the guard for
    // the producer that does NOT - a row's size must not depend on a caller having remembered it.
    expect(recordDetected.mock.calls[0][0].sources).toHaveLength(LAKE_FINDING_SOURCE_MAX);
  });

  // The boundary itself, where an off-by-one in the slice would live: MAX must pass through whole
  // and MAX + 1 must lose exactly one. The MAX + 5 case above is comfortably past either mistake.
  it.each([
    [LAKE_FINDING_SOURCE_MAX - 1, LAKE_FINDING_SOURCE_MAX - 1],
    [LAKE_FINDING_SOURCE_MAX, LAKE_FINDING_SOURCE_MAX],
    [LAKE_FINDING_SOURCE_MAX + 1, LAKE_FINDING_SOURCE_MAX],
  ])('stores %i sources as %i', async (supplied, expected) => {
    const recordDetected = vi.fn().mockResolvedValue({});
    const at = finding({
      evidence: Array.from({ length: supplied }, (_, i) => ({
        fabFileId: `file-${i}`,
        fileName: `${i}.md`,
        excerpt: 'x',
      })),
    });

    await recordLakeFindings('lake-1', [at], { detector: 'model', seenAt: SEEN_AT }, adapters(recordDetected));

    const sources = recordDetected.mock.calls[0][0].sources;
    expect(sources).toHaveLength(expected);
    // Truncation keeps the FIRST entries, so the detector's own ordering survives the cap.
    expect(sources[0].fabFileId).toBe('file-0');
    expect(sources[sources.length - 1].fabFileId).toBe(`file-${expected - 1}`);
  });

  it('preserves a null fileName rather than inventing one', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});
    const orphaned = finding({ evidence: [{ fabFileId: 'file-a', fileName: null, excerpt: 'x' }] });

    await recordLakeFindings('lake-1', [orphaned], { detector: 'lexical', seenAt: SEEN_AT }, adapters(recordDetected));

    expect(recordDetected.mock.calls[0][0].sources[0].fileName).toBeNull();
  });

  it('isolates a failed write so one bad finding does not cost the rest of the run', async () => {
    const recordDetected = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({});
    const deps = adapters(recordDetected);

    const result = await recordLakeFindings(
      'lake-1',
      [finding({ subject: 'a' }), finding({ subject: 'b' }), finding({ subject: 'c' })],
      { detector: 'lexical', seenAt: SEEN_AT },
      deps
    );

    // Counted and returned, not swallowed: a caller has to be able to report a partial write as
    // partial rather than as a clean run.
    expect(result).toEqual({ recorded: 2, failed: 1 });
    expect(recordDetected).toHaveBeenCalledTimes(3);
    expect(deps.logger.error).toHaveBeenCalledWith(
      'Failed to record lake finding',
      expect.objectContaining({ subject: 'b' })
    );
  });

  it('writes nothing and reports a clean run when a pass found nothing', async () => {
    const recordDetected = vi.fn().mockResolvedValue({});

    const result = await recordLakeFindings(
      'lake-1',
      [],
      { detector: 'lexical', seenAt: SEEN_AT },
      adapters(recordDetected)
    );

    expect(result).toEqual({ recorded: 0, failed: 0 });
    expect(recordDetected).not.toHaveBeenCalled();
  });

  it('runs without a logger', async () => {
    const recordDetected = vi.fn().mockRejectedValue(new Error('write failed'));

    const result = await recordLakeFindings(
      'lake-1',
      [finding()],
      { detector: 'lexical', seenAt: SEEN_AT },
      { db: { dataLakeFindings: { recordDetected } } }
    );

    expect(result).toEqual({ recorded: 0, failed: 1 });
  });
});
