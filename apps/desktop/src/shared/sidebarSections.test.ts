import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDEBAR_SECTIONS,
  normalizeSectionName,
  sectionOf,
  SIDEBAR_SECTION_NAME_MAX_LENGTH,
} from './sidebarSections';

describe('normalizeSectionName', () => {
  it('does not split an emoji that straddles the length cap', () => {
    const name = `${'a'.repeat(SIDEBAR_SECTION_NAME_MAX_LENGTH - 1)}\u{1F680}tail`;

    expect(normalizeSectionName(name)).toBe(`${'a'.repeat(SIDEBAR_SECTION_NAME_MAX_LENGTH - 1)}\u{1F680}`);
  });
});

describe('sectionOf', () => {
  it('reads only the session ids that were assigned', () => {
    const state = { ...EMPTY_SIDEBAR_SECTIONS, assignments: { 'session-a': 'section-1' } };

    expect(sectionOf(state, 'session-a')).toBe('section-1');
    expect(sectionOf(state, 'constructor')).toBeUndefined();
  });
});
