import { describe, it, expect } from 'vitest';
import {
  filterMembers,
  getMemberRole,
  paginate,
  rosterGridColumns,
  RosterFilters,
  RosterMember,
  sortMembers,
} from './memberRosterView';

const usage = (used: number) => ({ tracked: true, used, cap: null, isOverride: false });

const row = (overrides: Partial<RosterMember> & { id: string }): RosterMember => ({
  name: overrides.id,
  email: `${overrides.id}@example.test`,
  status: 'accepted',
  role: 'member',
  creditUsage: null,
  ...overrides,
});

const allFilters: RosterFilters = { search: '', role: 'all', status: 'all' };
const ids = (members: RosterMember[]) => members.map(m => m.id);

describe('getMemberRole', () => {
  const org = { userId: 'owner', adminUserIds: ['mgr'] };

  it.each([
    ['owner', 'owner'],
    ['mgr', 'manager'],
    ['a', 'member'],
  ])('maps %s to %s', (userId, expected) => {
    expect(getMemberRole(org, userId)).toBe(expected);
  });

  it('treats a missing manager list as no managers', () => {
    expect(getMemberRole({ userId: 'owner', adminUserIds: undefined }, 'mgr')).toBe('member');
  });
});

describe('filterMembers', () => {
  const members = [
    row({ id: 'ada', name: 'Ada Lovelace', email: 'ada@math.test', role: 'member' }),
    row({ id: 'bob', name: 'Bob', email: null, status: 'pending' }),
    row({ id: 'cy', name: 'Cy', email: undefined, role: 'manager' }),
  ];

  it('returns everything for empty filters', () => {
    expect(ids(filterMembers(members, allFilters))).toEqual(['ada', 'bob', 'cy']);
  });

  it('returns nothing for empty input', () => {
    expect(filterMembers([], { ...allFilters, search: 'x' })).toEqual([]);
  });

  it('matches the name case-insensitively and ignores surrounding space', () => {
    expect(ids(filterMembers(members, { ...allFilters, search: '  LOVE ' }))).toEqual(['ada']);
  });

  it('matches the email and skips rows without one', () => {
    expect(ids(filterMembers(members, { ...allFilters, search: 'MATH.test' }))).toEqual(['ada']);
  });

  it('filters by role', () => {
    expect(ids(filterMembers(members, { ...allFilters, role: 'manager' }))).toEqual(['cy']);
  });

  it('filters by status', () => {
    expect(ids(filterMembers(members, { ...allFilters, status: 'pending' }))).toEqual(['bob']);
    expect(ids(filterMembers(members, { ...allFilters, status: 'accepted' }))).toEqual(['ada', 'cy']);
  });

  it('combines every filter', () => {
    expect(filterMembers(members, { search: 'ada', role: 'member', status: 'pending' })).toEqual([]);
  });
});

describe('sortMembers', () => {
  const members = [
    row({ id: 'c', name: 'Cy', role: 'member', creditUsage: usage(5) }),
    row({ id: 'a', name: 'Ada', role: 'manager', creditUsage: null }),
    row({ id: 'b', name: 'Bob', role: 'owner', creditUsage: usage(50) }),
    row({ id: 'd', name: 'Dee', role: 'member', creditUsage: usage(5) }),
    row({ id: 'e', name: 'Eve', role: 'member', creditUsage: null }),
  ];

  it('does not mutate its input', () => {
    sortMembers(members, 'name', 'desc');
    expect(ids(members)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('sorts by name both ways', () => {
    expect(ids(sortMembers(members, 'name', 'asc'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(sortMembers(members, 'name', 'desc'))).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('sorts by role rank both ways, ties by name A-Z', () => {
    expect(ids(sortMembers(members, 'role', 'asc'))).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(ids(sortMembers(members, 'role', 'desc'))).toEqual(['c', 'd', 'e', 'a', 'b']);
  });

  it('sorts by usage both ways, ties by name and rows without usage last', () => {
    expect(ids(sortMembers(members, 'usage', 'asc'))).toEqual(['c', 'd', 'b', 'a', 'e']);
    expect(ids(sortMembers(members, 'usage', 'desc'))).toEqual(['b', 'c', 'd', 'a', 'e']);
  });

  it('returns an empty array for empty input', () => {
    expect(sortMembers([], 'usage', 'asc')).toEqual([]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 5 }, (_, i) => i + 1);

  it('returns the requested page', () => {
    expect(paginate(items, 2, 2)).toEqual({ items: [3, 4], page: 2, pageCount: 3, first: 3, last: 4 });
  });

  it('returns a short last page', () => {
    expect(paginate(items, 3, 2)).toEqual({ items: [5], page: 3, pageCount: 3, first: 5, last: 5 });
  });

  it('clamps a page past the end and below the start', () => {
    expect(paginate(items, 9, 2).page).toBe(3);
    expect(paginate(items, 0, 2).page).toBe(1);
  });

  it('has one empty page for no items', () => {
    expect(paginate([], 4, 2)).toEqual({ items: [], page: 1, pageCount: 1, first: 0, last: 0 });
  });

  it('defaults to 50 rows a page', () => {
    const many = Array.from({ length: 1000 }, (_, i) => i);
    const result = paginate(many, 20);
    expect(result.pageCount).toBe(20);
    expect(result.items).toHaveLength(50);
    expect(result.first).toBe(951);
    expect(result.last).toBe(1000);
  });
});

describe('rosterGridColumns', () => {
  it('has six tracks, plus a leading selection track when selectable', () => {
    const tracks = (value: string) => value.split(/ (?=minmax|\d+px)/).length;
    expect(tracks(rosterGridColumns(false))).toBe(6);
    expect(tracks(rosterGridColumns(true))).toBe(7);
    expect(rosterGridColumns(true).startsWith('32px ')).toBe(true);
  });
});
