import { describe, expect, it } from 'vitest';
import { formatChunkSampleDoc, selectChunkSample, type SampleableChunk } from './corpusChunkSample';

/** `f<file>c<n>`, so a failure names the file a chunk came from without a lookup. */
const corpus = (perFile: Record<string, number>, charLength = 500): SampleableChunk[] =>
  Object.entries(perFile).flatMap(([docId, n]) =>
    Array.from({ length: n }, (_, i) => ({ chunkId: `${docId}c${i + 1}`, docId, charLength }))
  );

describe('selectChunkSample', () => {
  it('draws the same sample twice under one seed and a different one under another', () => {
    const chunks = corpus({ f1: 10, f2: 10, f3: 10 });
    const ids = (seed: string) =>
      selectChunkSample({ chunks, count: 5, seed })
        .picked.map(c => c.chunkId)
        .join(',');
    expect(ids('alpha')).toBe(ids('alpha'));
    expect(ids('alpha')).not.toBe(ids('beta'));
  });

  it('spreads across files instead of over-weighting the long one', () => {
    // The whole reason this is not uniform over chunks: f1 holds 96% of the corpus mass, and a
    // proportional draw would spend the sample describing f1 rather than the corpus.
    const sample = selectChunkSample({ chunks: corpus({ f1: 500, f2: 10, f3: 10 }), count: 3, seed: 's' });
    expect(new Set(sample.picked.map(c => c.docId))).toEqual(new Set(['f1', 'f2', 'f3']));
    expect(sample.filesSampled).toBe(3);
    expect(sample.filesInCorpus).toBe(3);
  });

  it('picks WHICH files to draw from independently of how large they are', () => {
    // The stratification only decides anything when the sample is smaller than the file count,
    // which is the real case (tens of chunks from hundreds of files). Ranking files by size instead
    // of by hash passes every other test here and quietly draws the sample from the longest files,
    // which is the mass bias this module exists to avoid - so the property is asserted directly.
    // The two corpora hold the same files with their lengths REVERSED, so hash order is identical
    // and size order cannot be: a size-ranked selector has to return a different set for each.
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8];
    const names = sizes.map((_, i) => `f${i + 1}`);
    const build = (lengths: number[]) => corpus(Object.fromEntries(names.map((name, i) => [name, lengths[i]])));
    const files = (chunks: SampleableChunk[]) =>
      selectChunkSample({ chunks, count: 3, seed: 's' })
        .picked.map(c => c.docId)
        .sort();
    expect(files(build(sizes))).toEqual(files(build([...sizes].reverse())));
    expect(files(build(sizes))).toHaveLength(3);
  });

  it('takes one chunk per file before a second from any', () => {
    const sample = selectChunkSample({ chunks: corpus({ f1: 5, f2: 5, f3: 5 }), count: 5, seed: 's' });
    const perFile = new Map<string, number>();
    for (const chunk of sample.picked) perFile.set(chunk.docId, (perFile.get(chunk.docId) ?? 0) + 1);
    expect([...perFile.values()].sort()).toEqual([1, 2, 2]);
  });

  it('holds out the chunks a screen already used as negatives evidence', () => {
    const chunks = corpus({ f1: 2, f2: 2 });
    const sample = selectChunkSample({
      chunks,
      count: 4,
      seed: 's',
      excludeChunkIds: ['f1c1', 'f1c2'],
    });
    expect(sample.picked.map(c => c.chunkId).sort()).toEqual(['f2c1', 'f2c2']);
    expect(sample.excludedByHoldout).toBe(2);
    // f1 is gone from the stratification, not a file that took a slot and yielded nothing.
    expect(sample.filesSampled).toBe(1);
    expect(sample.filesInCorpus).toBe(2);
  });

  it('reports a shortfall rather than returning a sample that looks complete', () => {
    // A corpus smaller than the request is not an error, but a caller that read `picked.length` as
    // the count it asked for would report questions it never authored.
    const sample = selectChunkSample({ chunks: corpus({ f1: 2 }), count: 10, seed: 's' });
    expect(sample.picked).toHaveLength(2);
    expect(sample.shortfall).toBe(8);
  });

  it('applies a length filter only when asked, and counts what it dropped', () => {
    const chunks = [
      { chunkId: 'a', docId: 'f1', charLength: 40 },
      { chunkId: 'b', docId: 'f1', charLength: 900 },
    ];
    expect(selectChunkSample({ chunks, count: 2, seed: 's' }).picked).toHaveLength(2);
    const filtered = selectChunkSample({ chunks, count: 2, seed: 's', minChars: 200 });
    expect(filtered.picked.map(c => c.chunkId)).toEqual(['b']);
    expect(filtered.excludedByMinChars).toBe(1);
  });

  it('refuses a count that cannot describe a sample', () => {
    const chunks = corpus({ f1: 2 });
    expect(() => selectChunkSample({ chunks, count: 0, seed: 's' })).toThrow(/positive integer/);
    expect(() => selectChunkSample({ chunks, count: 1.5, seed: 's' })).toThrow(/positive integer/);
  });
});

describe('formatChunkSampleDoc', () => {
  const sample = selectChunkSample({ chunks: corpus({ f1: 1, f2: 1 }), count: 2, seed: 's' });
  const doc = (texts: ReadonlyMap<string, string>, overrides = {}) =>
    formatChunkSampleDoc({
      sample,
      model: 'text-embedding-3-small',
      dims: 1536,
      corpus: 'a-lake',
      texts,
      count: 2,
      ...overrides,
    });
  const bothTexts = new Map([
    ['f1c1', 'a passage about annealing'],
    ['f2c1', 'a passage about couplers'],
  ]);

  it('pairs each passage with a prefilled record naming its own file', () => {
    const out = doc(bothTexts);
    expect(out).toContain('> a passage about annealing');
    for (const chunk of sample.picked) {
      expect(out).toContain(`"supporting": ["${chunk.docId}"]`);
    }
    expect(out).toContain('"question": ""');
  });

  it('numbers the sections so an authored record joins back to a passage', () => {
    const out = doc(bothTexts);
    expect(out).toContain('## p01 - chunk');
    expect(out).toContain('## p02 - chunk');
    expect(out).toContain('"id": "p01"');
  });

  it('marks a chunk that has left the corpus instead of rendering it blank', () => {
    const out = doc(new Map([['f1c1', 'still here']]));
    expect(out).toContain('(missing from the corpus at read time)');
    expect(out).toMatch(/1 of 2 sampled chunk ids are no longer in the corpus/);
  });

  it('truncates a long passage and says it did', () => {
    const out = doc(
      new Map([
        ['f1c1', 'x'.repeat(9000)],
        ['f2c1', 'short'],
      ]),
      { maxChars: 100 }
    );
    expect(out).toContain('[truncated at 100 chars]');
    expect(out).not.toContain('x'.repeat(101));
  });

  it('records the seed and the file spread, so a sample can be re-drawn from the doc alone', () => {
    const out = doc(bothTexts);
    expect(out).toContain('seed `s`');
    expect(out).toContain('drawn from 2 of 2 files');
  });

  it('tells the author to mark a passage unusable rather than skip it silently', () => {
    // A hand-made skip is a selection, and an unrecorded selection is the bias this sampler exists
    // to avoid reintroducing at the last step.
    expect(doc(bothTexts)).toContain('MARK A PASSAGE UNUSABLE RATHER THAN SKIPPING IT');
  });
});
