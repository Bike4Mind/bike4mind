import { describe, it, expect } from 'vitest';
import { tagsForLakeIds } from './tagsForLakeIds';

const lakes = [
  { id: 'a', datalakeTag: 'datalake:research' },
  { id: 'b', datalakeTag: 'datalake:legal' },
  { id: 'c', datalakeTag: 'datalake:opti' },
];

describe('tagsForLakeIds', () => {
  it('maps the selected ids to the tags the session stores', () => {
    expect(tagsForLakeIds(lakes, ['a', 'c'])).toEqual(['datalake:research', 'datalake:opti']);
  });

  it('returns LIST order, not selection order, so an unchanged set writes an unchanged array', () => {
    // Otherwise ticking the same two lakes in the other order looks like a scope change to
    // anything diffing the stored array.
    expect(tagsForLakeIds(lakes, ['c', 'a'])).toEqual(tagsForLakeIds(lakes, ['a', 'c']));
  });

  it('drops an id with no lake in the list rather than guessing a tag for it', () => {
    // The list is access-filtered, so an unmatched id names a lake this caller cannot reach.
    expect(tagsForLakeIds(lakes, ['a', 'vanished'])).toEqual(['datalake:research']);
  });

  it('yields an empty array when every selected lake is unreachable, which reads as all-lakes', () => {
    // Documented consequence rather than desired behaviour: the caller cannot distinguish this
    // from "nothing selected", so a scope of only-unreachable lakes widens instead of narrowing.
    // Reachable only if the lake list and the selection disagree, which the picker prevents by
    // deriving its own selection from that same list.
    expect(tagsForLakeIds(lakes, ['vanished'])).toEqual([]);
  });

  it('handles an empty selection and an absent lake list without throwing', () => {
    expect(tagsForLakeIds(lakes, [])).toEqual([]);
    expect(tagsForLakeIds(undefined, ['a'])).toEqual([]);
  });

  it('does not repeat a tag when an id is selected twice', () => {
    expect(tagsForLakeIds(lakes, ['a', 'a'])).toEqual(['datalake:research']);
  });
});
