import { describe, it, expect, vi, afterEach } from 'vitest';
import { rankCandidateFilesByRelevance, withDeadline } from './forcedRetrievalCandidateSelection';

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
