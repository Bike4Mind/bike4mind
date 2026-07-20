import { describe, it, expect } from 'vitest';
import {
  buildFilenameMarkerRegex,
  filterRetrievalExcluded,
  isRetrievalExcluded,
  normalizeExclusionMarkers,
} from './retrievalExclusion';

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
