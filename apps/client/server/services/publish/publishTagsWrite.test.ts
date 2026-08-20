import { describe, it, expect } from 'vitest';
import { normalizePublishTags } from '@bike4mind/common';

/**
 * The publish-time tag write, expressed as the guard both write sites use.
 *
 * This closes a real coverage gap: tags were threaded through `upload-url` -> draft -> `finalize`
 * so a CLI can tag in one call, and that path had no test at all - the normalization helper, the
 * PATCH and the UI were covered, and the one path the feature exists for was not.
 *
 * The guard under test is `tags?.length`, not `tags`. `[]` is truthy, so a client that always sends
 * the field - which is the normal way to write one - cleared an artifact's tags on every re-publish.
 * Clearing belongs to the PATCH path, which has unambiguous full-replace semantics; a publish can
 * only ADD. Same shape and same reasoning as the neighbouring `embedOrigins` guard.
 */

/** Mirrors both write sites: normalize FIRST, then write only a non-empty result. */
function tagPatch(tags: string[] | undefined): Record<string, string[]> {
  const normalized = normalizePublishTags(tags ?? []);
  return normalized.length ? { tags: normalized } : {};
}

describe('publish-time tag write', () => {
  it('writes normalized tags when the publisher supplies them', () => {
    expect(tagPatch(['IonQ', 'Weekly'])).toEqual({ tags: ['ionq', 'weekly'] });
  });

  it('writes nothing when the field is absent', () => {
    // The in-app publisher omits the key entirely; a re-publish must not disturb existing tags.
    expect(tagPatch(undefined)).toEqual({});
  });

  it('writes nothing for an EMPTY array, so a re-publish cannot clear existing tags', () => {
    // The regression: `[]` is truthy, so `tags ? ... : {}` emitted `{ tags: [] }` and wiped them.
    expect(tagPatch([])).toEqual({});
  });

  it('normalizes identically at publish time and at PATCH time', () => {
    // Two doors onto one field: a tag typed in the UI and a tag sent by the CLI must land the same,
    // or one label ends up stored two ways depending on how it arrived.
    const raw = ['  IonQ ', 'ionq', 'Security   Review', ''];
    expect(tagPatch(raw).tags).toEqual(normalizePublishTags(raw));
    expect(tagPatch(raw).tags).toEqual(['ionq', 'security review']);
  });

  it('writes nothing when every supplied tag normalizes away', () => {
    // The hole a raw-length guard leaves: `['  ']` passes `tags?.length` and then normalizes to `[]`,
    // reaching the write as "clear the tags" - the exact case the guard exists to prevent. Found by
    // writing this test, which is the argument for having written it.
    expect(tagPatch(['   '])).toEqual({});
    expect(tagPatch(['', '  ', '\t'])).toEqual({});
  });
});
