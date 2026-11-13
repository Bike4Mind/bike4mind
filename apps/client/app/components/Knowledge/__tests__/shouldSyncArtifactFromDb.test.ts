import { describe, it, expect } from 'vitest';
import { shouldRestoreOpenArtifact, shouldStampPersistedVersion, shouldSyncArtifactFromDb } from '../KnowledgeViewer';

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

describe('shouldStampPersistedVersion', () => {
  it('stamps the persisted version on first open when the content matches and no version is carried', () => {
    expect(
      shouldStampPersistedVersion({
        currentContent: 'v3 code',
        latestContent: 'v3 code',
        currentVersion: undefined,
        latestVersion: 3,
      })
    ).toBe(true);
  });

  it('does not stamp when a save raced the first load and the content differs', () => {
    // The shown content is a just-saved newer copy; the DB still returns the previous version.
    expect(
      shouldStampPersistedVersion({
        currentContent: 'saved v3',
        latestContent: 'old v2',
        currentVersion: undefined,
        latestVersion: 2,
      })
    ).toBe(false);
  });

  it('never moves the version backwards', () => {
    expect(
      shouldStampPersistedVersion({
        currentContent: 'same',
        latestContent: 'same',
        currentVersion: 4,
        latestVersion: 3,
      })
    ).toBe(false);
  });

  it('does nothing when the carried version already matches', () => {
    expect(
      shouldStampPersistedVersion({
        currentContent: 'same',
        latestContent: 'same',
        currentVersion: 3,
        latestVersion: 3,
      })
    ).toBe(false);
  });

  it('does nothing when the persisted version is unknown', () => {
    expect(
      shouldStampPersistedVersion({
        currentContent: 'same',
        latestContent: 'same',
        currentVersion: undefined,
        latestVersion: undefined,
      })
    ).toBe(false);
  });
});

describe('shouldRestoreOpenArtifact', () => {
  it('restores the open artifact when the shown tab got a new version after a send cleared it', () => {
    expect(shouldRestoreOpenArtifact({ shownItemId: 'a1', openArtifactId: undefined, artifactId: 'a1' })).toBe(true);
  });

  it('leaves another tab alone', () => {
    expect(shouldRestoreOpenArtifact({ shownItemId: 'a2', openArtifactId: undefined, artifactId: 'a1' })).toBe(false);
  });

  it('does nothing when the open artifact already is the one that got the version', () => {
    expect(shouldRestoreOpenArtifact({ shownItemId: 'a1', openArtifactId: 'a1', artifactId: 'a1' })).toBe(false);
  });

  it('does nothing when nothing is shown', () => {
    expect(shouldRestoreOpenArtifact({ shownItemId: undefined, openArtifactId: undefined, artifactId: 'a1' })).toBe(
      false
    );
  });
});
