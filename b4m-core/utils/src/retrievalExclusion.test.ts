import { describe, it, expect } from 'vitest';
import {
  buildFilenameMarkerRegex,
  filterRetrievalExcluded,
  isRetrievalExcluded,
  normalizeExclusionMarkers,
} from './retrievalExclusion';
import { CHUNK_STALL_NOTICES } from '@bike4mind/common';

describe('normalizeExclusionMarkers', () => {
  it('trims, lowercases, and drops empties', () => {
    expect(normalizeExclusionMarkers([' MARK ', 'Foo', '', '  '])).toEqual(['mark', 'foo']);
  });
  it('returns [] for undefined', () => {
    expect(normalizeExclusionMarkers(undefined)).toEqual([]);
  });
});

describe('buildFilenameMarkerRegex', () => {
  it('returns null for unset/empty/whitespace markers (no-op)', () => {
    expect(buildFilenameMarkerRegex(undefined)).toBeNull();
    expect(buildFilenameMarkerRegex([])).toBeNull();
    expect(buildFilenameMarkerRegex([''])).toBeNull();
    expect(buildFilenameMarkerRegex(['  '])).toBeNull();
  });

  it('builds a DocumentDB-safe anchored alternation (no \\b, no i flag)', () => {
    const re = buildFilenameMarkerRegex(['MARK', 'a.b'])!;
    // No PCRE \b escape (DocumentDB regex subset); trailing boundary is end-of-string or non-word char.
    expect(re.source).toBe('^(mark|a\\.b)($|[^a-z0-9_])');
    expect(re.flags).toBe('');
  });

  it('matches leading marker at a word boundary, not a bare prefix', () => {
    const re = buildFilenameMarkerRegex(['MARK'])!;
    expect(re.test('mark - x.pdf')).toBe(true);
    expect(re.test('markdown.pdf')).toBe(false);
  });

  it('matches a marker that is the entire filename (end-of-string boundary)', () => {
    const re = buildFilenameMarkerRegex(['MARK'])!;
    expect(re.test('mark')).toBe(true);
  });
});

describe('isRetrievalExcluded', () => {
  it('excludes a filename beginning with a marker (case-insensitive)', () => {
    expect(
      isRetrievalExcluded({ fileName: 'MARK - Protocol.pdf', vectorized: true }, { excludeFilenameMarkers: ['MARK'] })
    ).toBe(true);
    expect(
      isRetrievalExcluded({ fileName: 'mark - protocol.pdf', vectorized: true }, { excludeFilenameMarkers: ['MARK'] })
    ).toBe(true);
  });

  it('does NOT exclude a legit word that merely starts with the marker letters', () => {
    expect(
      isRetrievalExcluded({ fileName: 'MARKdown.pdf', vectorized: true }, { excludeFilenameMarkers: ['MARK'] })
    ).toBe(false);
  });

  it('excludes an unvectorized file when vectorizedOnly is set', () => {
    expect(isRetrievalExcluded({ fileName: 'Clean.pdf', vectorized: false }, { vectorizedOnly: true })).toBe(true);
    expect(isRetrievalExcluded({ fileName: 'Clean.pdf', vectorized: true }, { vectorizedOnly: true })).toBe(false);
  });

  it('keeps a convergence-stranded file despite vectorizedOnly, so the withhold can report it', () => {
    // It is unvectorized because a halted wave DELETED its passages, not because it is an image or a
    // failed job. Dropping it here runs upstream of partitionByIndexAvailability, so the turn would
    // answer around the hole and report full coverage - the failure the withhold exists to prevent.
    const stranded = { fileName: 'Report.pdf', vectorized: false, chunkStallReason: 'rechunkPaused' as const };
    expect(isRetrievalExcluded(stranded, { vectorizedOnly: true })).toBe(false);
    expect(filterRetrievalExcluded([stranded], { vectorizedOnly: true })).toEqual([stranded]);
  });

  it('still excludes a stranded file whose NAME the surface excludes - naming it outranks the hole', () => {
    const marked = { fileName: 'MARK - Report.pdf', vectorized: false, chunkStallReason: 'rechunkPaused' as const };
    expect(isRetrievalExcluded(marked, { vectorizedOnly: true, excludeFilenameMarkers: ['MARK'] })).toBe(true);
  });

  it('exempts the vectorize-arm marker too, so it reaches the withhold on a vectorizedOnly lake', () => {
    // This assertion used to be the opposite, on the premise that a vectorize-arm file "keeps its
    // chunks and is served". QA disproved it live: the search read path requires
    // `vector: {$exists: true, $ne: []}`, so a file with chunks and zero vectors returns nothing while
    // its neighbours are re-ranked into the top-K - the answer confidently contradicted the missing
    // document. Both arms must reach partitionByIndexAvailability to be refused and NAMED.
    const vectorizePaused = { fileName: 'Report.pdf', vectorized: false, chunkStallReason: 'vectorizePaused' as const };
    expect(isRetrievalExcluded(vectorizePaused, { vectorizedOnly: true })).toBe(false);
    expect(filterRetrievalExcluded([vectorizePaused], { vectorizedOnly: true })).toEqual([vectorizePaused]);
  });

  it('keeps a PRE-MIGRATION stranded file, whose marker is still legacy prose in notes', () => {
    // The queue stack does not wait on #2016's migrator, and a code rollback does not revert the
    // data, so both windows can hand this reader a row with the marker only in `notes`. Without the
    // transitional arm it is dropped here - upstream of the withhold - and the hole goes unreported.
    const legacy = { fileName: 'Report.pdf', vectorized: false, notes: CHUNK_STALL_NOTICES.rechunkPaused };
    expect(isRetrievalExcluded(legacy, { vectorizedOnly: true })).toBe(false);
    // The owner's own prose is not a marker; only the exact handler wording is.
    const owner = { fileName: 'Report.pdf', vectorized: false, notes: 'paused, I think?' };
    expect(isRetrievalExcluded(owner, { vectorizedOnly: true })).toBe(true);
  });

  // #1939, and the wider hole of the three: the reset writes `vectorized: false` and clears `notes`
  // in ONE write, so for the whole window between it and the consumer's marker there is no note for
  // the arms above to match. On a producer that died before its sends, that window never ends.
  it('keeps a file with a rebuild outstanding, which carries no note to key on', () => {
    const rebuilding = { fileName: 'Report.pdf', vectorized: false, notes: '', chunkRebuildRequestedAt: new Date() };
    expect(isRetrievalExcluded(rebuilding, { vectorizedOnly: true })).toBe(false);
    expect(filterRetrievalExcluded([rebuilding], { vectorizedOnly: true })).toEqual([rebuilding]);
    // Without the stamp it is an ordinary unvectorized file again, and still excluded.
    expect(isRetrievalExcluded({ ...rebuilding, chunkRebuildRequestedAt: null }, { vectorizedOnly: true })).toBe(true);
  });

  it('combines both rules (either triggers exclusion)', () => {
    const opts = { excludeFilenameMarkers: ['MARK'], vectorizedOnly: true };
    expect(isRetrievalExcluded({ fileName: 'MARK - x.pdf', vectorized: true }, opts)).toBe(true); // marker
    expect(isRetrievalExcluded({ fileName: 'Clean.pdf', vectorized: false }, opts)).toBe(true); // unvectorized
    expect(isRetrievalExcluded({ fileName: 'Clean.pdf', vectorized: true }, opts)).toBe(false); // neither
  });

  it('is a no-op with empty options or missing fileName', () => {
    expect(isRetrievalExcluded({ fileName: 'MARK - x.pdf', vectorized: true }, {})).toBe(false);
    expect(isRetrievalExcluded({ fileName: null, vectorized: true }, { excludeFilenameMarkers: ['MARK'] })).toBe(false);
    expect(isRetrievalExcluded({ vectorized: true }, { excludeFilenameMarkers: ['MARK'] })).toBe(false);
  });
});

describe('filterRetrievalExcluded', () => {
  const files = [
    { fileName: 'MARK - retired.pdf', vectorized: true },
    { fileName: 'Current.pdf', vectorized: true },
    { fileName: 'Draft.pdf', vectorized: false },
    { fileName: 'MARKdown guide.pdf', vectorized: true },
  ];

  it('drops marker-matched and (when set) unvectorized files, keeping the rest', () => {
    const kept = filterRetrievalExcluded(files, { excludeFilenameMarkers: ['MARK'], vectorizedOnly: true });
    expect(kept.map(f => f.fileName)).toEqual(['Current.pdf', 'MARKdown guide.pdf']);
  });

  it('returns the same array reference (passthrough) when opts are empty', () => {
    expect(filterRetrievalExcluded(files, {})).toBe(files);
    expect(filterRetrievalExcluded(files, { excludeFilenameMarkers: ['', '  '] })).toBe(files);
  });
});
