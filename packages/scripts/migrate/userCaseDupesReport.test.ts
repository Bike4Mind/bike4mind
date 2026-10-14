import { describe, it, expect } from 'vitest';
import { findCaseInsensitiveCollisions, renderCollisionGroups, type UserIdentityRow } from './userCaseDupesReport';

const row = (id: string, value: unknown): UserIdentityRow => ({
  id,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  emailVerified: true,
  value,
});

describe('findCaseInsensitiveCollisions', () => {
  it('groups values that differ only by case or surrounding whitespace', () => {
    const groups = findCaseInsensitiveCollisions([
      row('a', 'Pat@Example.com'),
      row('b', ' pat@example.com '),
      row('c', 'other@example.com'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].map(member => member.id)).toEqual(['a', 'b']);
  });

  it('skips non-string and empty values', () => {
    const groups = findCaseInsensitiveCollisions([
      row('a', null),
      row('b', null),
      row('c', ''),
      row('d', '  '),
      row('e', 42),
    ]);

    expect(groups).toEqual([]);
  });

  it('orders the largest groups first', () => {
    const groups = findCaseInsensitiveCollisions([
      row('a', 'x'),
      row('b', 'X'),
      row('c', 'y'),
      row('d', 'Y'),
      row('e', ' y'),
    ]);

    expect(groups.map(group => group.length)).toEqual([3, 2]);
  });
});

describe('renderCollisionGroups', () => {
  it('prints ids and metadata but never the colliding value', () => {
    const lines = renderCollisionGroups(
      'email',
      findCaseInsensitiveCollisions([row('a', 'Pat@Example.com'), row('b', 'pat@example.com')])
    );

    expect(lines.join('\n')).not.toMatch(/pat@example\.com/i);
    expect(lines).toContain('    id=a createdAt=2026-01-01T00:00:00.000Z emailVerified=true');
  });

  it('reports a clean result', () => {
    expect(renderCollisionGroups('username', [])).toEqual(['No case-insensitive username collisions.']);
  });
});
