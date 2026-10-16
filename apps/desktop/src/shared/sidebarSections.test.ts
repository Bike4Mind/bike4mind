import { describe, expect, it } from 'vitest';
import { normalizeSectionName, SIDEBAR_SECTION_NAME_MAX_LENGTH } from './sidebarSections';

describe('normalizeSectionName', () => {
  it('does not split an emoji that straddles the length cap', () => {
    const name = `${'a'.repeat(SIDEBAR_SECTION_NAME_MAX_LENGTH - 1)}\u{1F680}tail`;

    expect(normalizeSectionName(name)).toBe(`${'a'.repeat(SIDEBAR_SECTION_NAME_MAX_LENGTH - 1)}\u{1F680}`);
  });
});
