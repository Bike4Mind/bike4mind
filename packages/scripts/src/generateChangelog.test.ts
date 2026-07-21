import { describe, it, expect } from 'vitest';
import { buildFallbackTitle, extractPRNumber } from './generateChangelog';

describe('extractPRNumber', () => {
  it('reads the trailing (#N) suffix from a squash-merge subject', () => {
    expect(extractPRNumber('feat(memory): Mementos 2.0 - unified principal-scoped memory core (#442)')).toBe(442);
  });

  it('reads a plain squash suffix even with no scope', () => {
    expect(extractPRNumber('fix: resolve spinner (#663)')).toBe(663);
  });

  it('reads the merge-commit form', () => {
    expect(extractPRNumber('Merge pull request #741 from Bike4Mind/ci/e2e-plumbing-extraction')).toBe(741);
  });

  it('takes the TRAILING (#N) and ignores an inner (epic #N)', () => {
    expect(extractPRNumber('feat(agents): per-embed-key spend cap with pre-flight enforcement (epic #41) (#727)')).toBe(
      727
    );
  });

  it('ignores issue / epic / prose references in the body', () => {
    const message = [
      'feat(memory): Mementos 2.0 (#442)',
      '',
      'the OFF-topic "favorite color is green" ranked #1',
      '(activation .238) while the on-topic belief ranked #3, "favorite color" down at #4.',
      'Closes #627',
      'Issue #471 covers the file corpus.',
    ].join('\n');
    expect(extractPRNumber(message)).toBe(442);
  });

  it('ignores mid-subject epic/issue references when there is no trailing PR suffix', () => {
    expect(extractPRNumber('feat(agents): embed endpoint (epic #41 - Phase B.1)')).toBeNull();
  });

  it('does not treat a bare "Closes #N" body line as a PR', () => {
    expect(extractPRNumber('fix(client): register auth interceptors\n\nCloses #627')).toBeNull();
  });

  it('returns null for a direct commit with no PR reference', () => {
    expect(extractPRNumber('hotfix: bump timeout')).toBeNull();
  });
});

describe('buildFallbackTitle', () => {
  it('uses the single change as the title, capitalized', () => {
    expect(
      buildFallbackTitle([{ type: 'features', items: ['add settlement view to admin usage-margin endpoint'] }])
    ).toBe('Add settlement view to admin usage-margin endpoint');
  });

  it('summarizes multiple changes across sections by count', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a', 'b', 'c'] },
        { type: 'fixes', items: ['x', 'y'] },
      ])
    ).toBe('3 features and 2 fixes');
  });

  it('uses singular nouns for single-item sections in a multi-section summary', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a'] },
        { type: 'fixes', items: ['x'] },
      ])
    ).toBe('1 feature and 1 fix');
  });

  it('oxford-joins three or more sections', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: ['a', 'b'] },
        { type: 'fixes', items: ['x'] },
        { type: 'performance', items: ['p', 'q'] },
      ])
    ).toBe('2 features, 1 fix, and 2 performance improvements');
  });

  it('ignores empty sections when counting', () => {
    expect(
      buildFallbackTitle([
        { type: 'features', items: [] },
        { type: 'fixes', items: ['only one'] },
      ])
    ).toBe('Only one');
  });

  it('degrades to a generic title only when nothing is categorized', () => {
    expect(buildFallbackTitle([])).toBe('Production Release');
    expect(buildFallbackTitle([{ type: 'internal', items: [] }])).toBe('Production Release');
  });
});
