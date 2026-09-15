import { describe, it, expect } from 'vitest';
import { shouldSyncArtifactFromDb } from '../KnowledgeViewer';

describe('shouldSyncArtifactFromDb', () => {
  it('does not downgrade the just-opened version during the persist race (#457)', () => {
    // We show the freshly-iterated v2 ("new"); the DB still holds the previous version ("old")
    // at the same version number as the pinned baseline. Must NOT adopt it.
    expect(
      shouldSyncArtifactFromDb({
        currentContent: 'new',
        latestContent: 'old',
        latestVersion: 1,
        baselineVersion: 1,
      })
    ).toBe(false);
  });

  it('adopts the DB copy when it is a strictly newer version than the baseline', () => {
    // The persist caught up / a genuinely newer version exists.
    expect(
      shouldSyncArtifactFromDb({
        currentContent: 'shown',
        latestContent: 'newer',
        latestVersion: 2,
        baselineVersion: 1,
      })
    ).toBe(true);
  });

  it('does nothing when the DB content already matches what is shown', () => {
    expect(
      shouldSyncArtifactFromDb({
        currentContent: 'same',
        latestContent: 'same',
        latestVersion: 5,
        baselineVersion: 1,
      })
    ).toBe(false);
  });

  it('does not adopt a differing DB copy at a lower version than the baseline', () => {
    expect(
      shouldSyncArtifactFromDb({
        currentContent: 'shown',
        latestContent: 'stale',
        latestVersion: 1,
        baselineVersion: 3,
      })
    ).toBe(false);
  });

  it('treats missing versions as 0 (equal -> no downgrade)', () => {
    // Both undefined -> 0, not strictly greater, and content differs -> keep what is shown.
    expect(
      shouldSyncArtifactFromDb({
        currentContent: 'fresh',
        latestContent: 'stale',
        latestVersion: undefined,
        baselineVersion: undefined,
      })
    ).toBe(false);
  });
});
