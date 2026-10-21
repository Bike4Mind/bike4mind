import { describe, it, expect } from 'vitest';
import { ALL_REPOSITORIES, filterToScope, isRepositoryInScope, parseRepoScope } from '../repoScope.js';

describe('parseRepoScope', () => {
  it('treats an absent variable as all repositories', () => {
    expect(parseRepoScope(undefined)).toEqual(ALL_REPOSITORIES);
  });

  it('restricts to the listed repositories, ignoring case', () => {
    const scope = parseRepoScope(JSON.stringify(['Acme/Widgets', 'acme/gadgets']));

    expect(isRepositoryInScope(scope, 'acme/widgets')).toBe(true);
    expect(isRepositoryInScope(scope, 'ACME/GADGETS')).toBe(true);
    expect(isRepositoryInScope(scope, 'acme/other')).toBe(false);
  });

  it('does not match on a name prefix or across owners', () => {
    const scope = parseRepoScope(JSON.stringify(['acme/widgets']));

    expect(isRepositoryInScope(scope, 'acme/widgets-private')).toBe(false);
    expect(isRepositoryInScope(scope, 'other/widgets')).toBe(false);
  });

  it.each([
    ['malformed JSON', '[acme/widgets'],
    ['a non-array', '"acme/widgets"'],
    ['an entry without an owner', '["widgets"]'],
    ['a non-string entry', '[42]'],
  ])('throws on %s rather than guessing', (_label, rawValue) => {
    expect(() => parseRepoScope(rawValue)).toThrow(/GITHUB_SELECTED_REPOSITORIES/);
  });
});

describe('filterToScope', () => {
  const items = [{ fullName: 'acme/widgets' }, { fullName: 'other/secret' }];

  it('keeps only items in selected repositories', () => {
    const scope = parseRepoScope(JSON.stringify(['ACME/widgets']));

    expect(filterToScope(scope, items, item => item.fullName)).toEqual([{ fullName: 'acme/widgets' }]);
  });

  it('keeps everything when all repositories are selected', () => {
    expect(filterToScope(ALL_REPOSITORIES, items, item => item.fullName)).toEqual(items);
  });
});
