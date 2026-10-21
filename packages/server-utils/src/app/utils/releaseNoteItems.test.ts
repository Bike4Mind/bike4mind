import { describe, it, expect } from 'vitest';
import { ReleaseNoteCategorySchema, type ReleaseNoteCategory } from '@bike4mind/common';
import { groupReleaseNoteItems } from './releaseNoteItems';

const item = (category: ReleaseNoteCategory, text: string, importance: number) => ({ category, text, importance });

describe('groupReleaseNoteItems', () => {
  it('orders the headings New, Improved, Fixed', () => {
    const grouped = groupReleaseNoteItems([item('fixed', 'f', 1), item('improved', 'i', 1), item('new', 'n', 1)]);
    expect(grouped.map(group => group.heading)).toEqual(['New', 'Improved', 'Fixed']);
  });

  it('covers every category the schema allows', () => {
    // The Record type already fails typecheck on a new category; this is the runtime backstop that its
    // items are not silently dropped from the slides and the highlights prompt.
    const categories = ReleaseNoteCategorySchema.options;
    const grouped = groupReleaseNoteItems(categories.map(category => item(category, String(category), 1)));
    expect(grouped).toHaveLength(categories.length);
  });

  it('sorts items most notable first within a heading', () => {
    const grouped = groupReleaseNoteItems([item('new', 'minor', 3), item('new', 'big', 1), item('new', 'mid', 2)]);
    expect(grouped[0].items.map(entry => entry.text)).toEqual(['big', 'mid', 'minor']);
  });

  it('omits a category with no items', () => {
    const grouped = groupReleaseNoteItems([item('improved', 'only', 1)]);
    expect(grouped.map(group => group.heading)).toEqual(['Improved']);
  });
});
