import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  rankCandidateFilesByRelevance,
  selectRelevanceCandidates,
  withDeadline,
} from './forcedRetrievalCandidateSelection';

const NOW = new Date('2026-09-29T12:00:00Z');
const STAMPED = new Date('2026-09-01T00:00:00Z');

const file = (id: string, stamped: Date | null = STAMPED) => ({ id, chunkEmbeddingModelStampedAt: stamped });

describe('rankCandidateFilesByRelevance', () => {
  it('orders hit files by their best chunk score, one entry per file', () => {
    const files = [file('a'), file('b'), file('c')];
    const ranked = rankCandidateFilesByRelevance(
      files,
      [
        { fabFileId: 'b', score: 0.4 },
        { fabFileId: 'c', score: 0.9 },
        { fabFileId: 'b', score: 0.95 },
        { fabFileId: 'a', score: 0.5 },
      ],
      NOW
    );
    expect(ranked.map(f => f.id)).toEqual(['b', 'c', 'a']);
  });

  it('puts index-unready files after hits and before ready files the ANN ranked outside its pool', () => {
    const justStamped = new Date(NOW.getTime() - 1000);
    const files = [file('ready-miss'), file('unstamped', null), file('hit'), file('lagging', justStamped)];
    const ranked = rankCandidateFilesByRelevance(files, [{ fabFileId: 'hit', score: 0.7 }], NOW);
    expect(ranked.map(f => f.id)).toEqual(['hit', 'unstamped', 'lagging', 'ready-miss']);
  });

  it('breaks score ties by id and ignores non-finite scores and hits outside the file set', () => {
    const files = [file('z'), file('y'), file('x')];
    const ranked = rankCandidateFilesByRelevance(
      files,
      [
        { fabFileId: 'z', score: 0.8 },
        { fabFileId: 'y', score: 0.8 },
        { fabFileId: 'x', score: Number.NaN },
        { fabFileId: 'not-in-scope', score: 0.99 },
      ],
      NOW
    );
    expect(ranked.map(f => f.id)).toEqual(['y', 'z', 'x']);
  });
});

describe('selectRelevanceCandidates', () => {
  const opts = { cap: 100, notIndexedReserve: 10 };
  const fresh = new Date(NOW.getTime() - 1000);
  const hitFiles = (n: number) => Array.from({ length: n }, (_, i) => file(`h${String(i).padStart(3, '0')}`));
  const hitsFor = (files: { id: string }[]) => files.map((f, i) => ({ fabFileId: f.id, score: 1 - i / 1000 }));

  it('keeps a not-yet-indexed file inside the cap when hits alone would fill it', () => {
    const hits = hitFiles(110);
    const target = file('zz-fresh', fresh);
    const { files, notIndexedCut } = selectRelevanceCandidates([...hits, target], hitsFor(hits), NOW, opts);
    expect(files).toHaveLength(100);
    expect(files.map(f => f.id)).toContain('zz-fresh');
    expect(notIndexedCut).toBe(0);
  });

  it('reports the lag-window files that do not fit beside a partial set of hits', () => {
    const hits = hitFiles(30);
    const recent = Array.from({ length: 80 }, (_, i) => file(`fresh${String(i).padStart(2, '0')}`, fresh));
    const { files, notIndexedCut } = selectRelevanceCandidates([...hits, ...recent], hitsFor(hits), NOW, opts);
    expect(files.map(f => f.id)).toEqual([...recent.slice(0, 10), ...hits, ...recent.slice(10, 70)].map(f => f.id));
    expect(notIndexedCut).toBe(10);
  });

  it('reports the not-yet-indexed files the reserve could not hold, and keeps the top hits', () => {
    const hits = hitFiles(110);
    const freshFiles = Array.from({ length: 15 }, (_, i) => file(`fresh${i}`, fresh));
    const { files, notIndexedCut } = selectRelevanceCandidates([...hits, ...freshFiles], hitsFor(hits), NOW, opts);
    expect(files).toHaveLength(100);
    const keptFresh = files.filter(f => f.id.startsWith('fresh'));
    expect(keptFresh.map(f => f.id)).toEqual(Array.from({ length: 10 }, (_, i) => `fresh${i}`));
    expect(files.slice(0, 10).map(f => f.id)).toEqual(keptFresh.map(f => f.id));
    expect(files.slice(10).map(f => f.id)).toEqual(hits.slice(0, 90).map(f => f.id));
    expect(notIndexedCut).toBe(5);
  });

  it('keeps the tier order when hits do not fill the cap', () => {
    const hits = hitFiles(30);
    const notIndexed = Array.from({ length: 50 }, (_, i) => file(`ni${i}`, null));
    const misses = Array.from({ length: 40 }, (_, i) => file(`miss${i}`));
    const input = [...misses, ...notIndexed, ...hits];
    const { files, notIndexedCut } = selectRelevanceCandidates(input, hitsFor(hits), NOW, opts);
    expect(files.map(f => f.id)).toEqual(
      rankCandidateFilesByRelevance(input, hitsFor(hits), NOW)
        .slice(0, 100)
        .map(f => f.id)
    );
    expect(notIndexedCut).toBe(0);
  });

  it('counts recently stamped files cut when they alone overflow the cap', () => {
    const recent = Array.from({ length: 120 }, (_, i) => file(`ni${i}`, fresh));
    expect(selectRelevanceCandidates(recent, [], NOW, opts)).toMatchObject({ notIndexedCut: 20 });
  });

  it('never gives a never-stamped file a reserved slot, so the fresh file and top hits survive', () => {
    const hits = hitFiles(110);
    const unstamped = Array.from({ length: 15 }, (_, i) => file(`a-img${i}`, null));
    const target = file('m-new', fresh);
    const { files, notIndexedCut } = selectRelevanceCandidates(
      [...unstamped, target, ...hits],
      hitsFor(hits),
      NOW,
      opts
    );
    expect(files).toHaveLength(100);
    expect(files.map(f => f.id)).toContain('m-new');
    expect(files.map(f => f.id)).toEqual(['m-new', ...hits.slice(0, 99).map(f => f.id)]);
    expect(notIndexedCut).toBe(0);
  });

  it('cuts never-stamped files silently when hits fill the cap', () => {
    const hits = hitFiles(110);
    const unstamped = Array.from({ length: 15 }, (_, i) => file(`a-img${i}`, null));
    const { files, notIndexedCut } = selectRelevanceCandidates([...unstamped, ...hits], hitsFor(hits), NOW, opts);
    expect(files.map(f => f.id)).toEqual(hits.slice(0, 100).map(f => f.id));
    expect(notIndexedCut).toBe(0);
  });
});

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles first', async () => {
    await expect(withDeadline(Promise.resolve(7), 50, 'probe')).resolves.toBe(7);
  });

  it('rejects once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<never>(() => {}), 50, 'probe');
    const assertion = expect(pending).rejects.toThrow('probe exceeded 50ms');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});
