import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CURATED_TEXT } from './curated/bundled';
import { loadCuratedManifest, olderThan } from './loadCuratedManifest';

describe('olderThan', () => {
  it.each([
    ['0.1.11', '0.1.12', true],
    ['0.1.12', '0.1.12', false],
    ['0.1.13', '0.1.12', false],
    ['0.2.0', '0.1.12', false],
    ['1.0.0', '0.9.9', false],
    ['0.1.12-beta.1', '0.1.12', false],
    ['0.1.11-beta.1', '0.1.12', true],
    ['invalid', '0.1.12', false],
    ['', '0.1.12', false],
    ['0.1.12', 'invalid', false],
  ])('compares %s to %s by major.minor.patch', (version, minimum, expected) => {
    expect(olderThan(version, minimum)).toBe(expected);
  });
});

describe('loadCuratedManifest Desktop compatibility', () => {
  const fixture = () => {
    const list = JSON.parse(BUNDLED_CURATED_TEXT) as {
      entries: { id: string; minDesktopVersion?: string }[];
    };
    list.entries[0].minDesktopVersion = '0.2.0';
    return list;
  };

  it.each([
    ['0.1.12', false],
    ['0.2.0', true],
    ['0.2.1', true],
    ['0.2.0-beta.1', true],
    ['invalid', true],
    [undefined, true],
  ])('filters only entries newer than Desktop %s', (desktopVersion, keep) => {
    const input = fixture();
    const warn = vi.fn();
    const manifest = loadCuratedManifest(warn, input, { desktopVersion });
    expect(manifest.entries.some(entry => entry.id === input.entries[0].id)).toBe(keep);
    expect(manifest.entries.map(entry => entry.id)).toEqual(input.entries.slice(keep ? 0 : 1).map(entry => entry.id));
    if (keep) expect(warn).not.toHaveBeenCalled();
    else expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs Desktop 0.2.0 or newer'));
  });

  it('falls back to the bundled list when the envelope is unreadable', () => {
    const warn = vi.fn();
    const desktopVersion = '0.1.12';
    const expected = loadCuratedManifest(() => {}, undefined, { desktopVersion });
    expect(loadCuratedManifest(warn, { schemaVersion: 3 }, { desktopVersion })).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('showing the bundled one'));
  });
});
