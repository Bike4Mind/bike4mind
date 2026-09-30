import { describe, expect, it } from 'vitest';
import { isValidBranchName, suggestBranchName } from './branchName';

describe('suggestBranchName', () => {
  it('slugs the title when there is one', () => {
    expect(suggestBranchName('Fix the login redirect', 'something much longer')).toBe('agent/fix-the-login-redirect');
  });

  it('falls back to the prompt when the title is missing', () => {
    expect(suggestBranchName(undefined, 'Update the README')).toBe('agent/update-the-readme');
  });

  it('keeps the name short enough to read as a folder', () => {
    const branch = suggestBranchName('a'.repeat(200), 'x');
    expect(branch.length).toBeLessThanOrEqual('agent/'.length + 40);
  });

  it('distinguishes two tasks that both slug to nothing, so the fallback is not a dead end', () => {
    // A constant fallback would collide with itself, and a collision is refused rather than
    // resolved - so the second such spawn would fail for a reason the user had to guess at.
    expect(suggestBranchName('!!!', 'one task')).not.toBe(suggestBranchName('???', 'another task'));
  });

  it('only ever suggests names git will take', () => {
    for (const title of ['!!!', 'Feature: "quoted" ~ thing', '  ', '../escape', 'ends with a dot.']) {
      expect(isValidBranchName(suggestBranchName(title, 'fallback prompt'))).toBe(true);
    }
  });
});

describe('isValidBranchName', () => {
  it('accepts ordinary names', () => {
    for (const branch of ['agent/thing', 'fix/3456-crash', 'main', 'release-1.2']) {
      expect(isValidBranchName(branch)).toBe(true);
    }
  });

  it('rejects what git would', () => {
    for (const branch of ['', ' ', 'has space', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a\\b']) {
      expect(isValidBranchName(branch)).toBe(false);
    }
  });

  it('rejects the path shapes that would escape or confuse the container directory', () => {
    for (const branch of ['/leading', 'trailing/', 'double//slash', '.hidden', 'sub/.hidden', 'work.lock']) {
      expect(isValidBranchName(branch)).toBe(false);
    }
  });
});
