// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ICallableFunctionPublic, ICallableFunctionShared } from '@bike4mind/common';
import { groupFunctionLibrary, matchesFunctionSearch } from './libraryGrouping';

const own = (id: string, overrides: Partial<ICallableFunctionPublic> = {}) =>
  ({
    id,
    slug: `fn_${id}`,
    description: 'Midspan deflection of a simply supported beam.',
    status: 'live',
    state: 'live',
    trustLabel: 'verified',
    ...overrides,
  }) as ICallableFunctionPublic;

const received = (id: string, overrides: Partial<ICallableFunctionShared> = {}) =>
  ({
    id,
    slug: `shared_${id}`,
    description: 'Pressure drop along a pipe.',
    status: 'pending_review',
    trustLabel: 'platform',
    ownerName: 'Avery Owner',
    ...overrides,
  }) as ICallableFunctionShared;

describe('groupFunctionLibrary', () => {
  it('splits the lists into Mine and Shared with me, with no public group while no list returns one', () => {
    const groups = groupFunctionLibrary({ mine: [own('a')], shared: [received('b')] });
    expect(groups.map(group => [group.key, group.title])).toEqual([
      ['mine', 'Mine'],
      ['shared', 'Shared with me'],
    ]);
    expect(groups[0].rows[0]).toEqual({
      id: 'a',
      slug: 'fn_a',
      description: 'Midspan deflection of a simply supported beam.',
      state: 'live',
      trustLabel: 'verified',
    });
    expect(groups[1].rows[0]).toMatchObject({
      state: 'live',
      trustLabel: 'platform',
      ownerName: 'Avery Owner',
      review: 'pending_review',
    });
  });

  it('puts a public group first once a list returns one', () => {
    const groups = groupFunctionLibrary({
      mine: [],
      shared: [],
      public: [
        {
          id: 'p',
          slug: 'unit_convert',
          description: 'Converts units.',
          trustLabel: 'platform',
          ownerName: 'Bike4Mind',
        },
      ],
    });
    expect(groups.map(group => group.key)).toEqual(['public', 'mine', 'shared']);
    expect(groups[0].rows[0]).toMatchObject({ state: 'live', trustLabel: 'platform', ownerName: 'Bike4Mind' });
  });

  it('reads draft, live, and off from each list', () => {
    const [mine, shared] = groupFunctionLibrary({
      mine: [
        own('a', { status: 'draft', state: 'draft', trustLabel: null }),
        own('b', { status: 'disabled' }),
        own('c', { status: 'source_deleted' }),
      ],
      shared: [received('d', { status: 'disabled' }), received('e', { status: 'reviewed' })],
    });
    expect(mine.rows.map(row => row.state)).toEqual(['draft', 'off', 'off']);
    expect(shared.rows.map(row => row.state)).toEqual(['off', 'live']);
  });

  it('says an empty group is empty in one line, and says so differently while searching', () => {
    const [mine, shared] = groupFunctionLibrary({ mine: [], shared: [] });
    expect(mine.empty).toBe("You have no functions yet. Make one from a Python artifact's Function tab.");
    expect(shared.empty).toBe('No one has shared a function with you.');
    const searched = groupFunctionLibrary({ mine: [own('a')], shared: [] }, 'nothing like it');
    expect(searched[0].rows).toEqual([]);
    expect(searched[0].empty).toBe('No functions here match your search.');
  });

  it('searches the name and the description in both groups', () => {
    const lists = { mine: [own('a'), own('b', { description: 'Heat loss.' })], shared: [received('c')] };
    const byName = groupFunctionLibrary(lists, 'FN_B');
    expect(byName.map(group => group.rows.map(row => row.id))).toEqual([['b'], []]);
    const byDescription = groupFunctionLibrary(lists, 'pipe');
    expect(byDescription.map(group => group.rows.map(row => row.id))).toEqual([[], ['c']]);
  });
});

describe('matchesFunctionSearch', () => {
  it('matches every row on a blank search', () => {
    expect(matchesFunctionSearch({ slug: 'x', description: 'y' }, '   ')).toBe(true);
  });
});
