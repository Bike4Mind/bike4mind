import { describe, expect, it } from 'vitest';
import { SKILL_FILE_LIMITS, checkSkillFiles } from './skillFiles';

const file = (path: string, content = 'x') => ({ path, content });
const errorOf = (files: { path: string; content: string }[]) => {
  const result = checkSkillFiles(files);
  return result.ok ? null : result.error;
};

describe('checkSkillFiles', () => {
  it('accepts scripts/ and references/ files and sorts them by path', () => {
    const result = checkSkillFiles([file('scripts/run.py'), file('references/api/v2.md'), file('references/a.md')]);
    expect(result).toEqual({
      ok: true,
      files: [file('references/a.md'), file('references/api/v2.md'), file('scripts/run.py')],
    });
  });

  it.each([
    ['../etc/passwd'],
    ['scripts/../../x'],
    ['scripts/./x.sh'],
    ['/scripts/x.sh'],
    ['scripts//x.sh'],
    ['scripts\\x.sh'],
    ['scripts/.env'],
    ['scripts'],
    ['SKILL.md'],
    ['assets/logo.svg'],
    ['Scripts/x.sh'],
    ['scripts/a b.sh'],
  ])('rejects %s, naming the path', path => {
    expect(errorOf([file(path)])).toContain(path);
  });

  it('rejects a path over the length cap', () => {
    expect(errorOf([file(`references/${'a'.repeat(SKILL_FILE_LIMITS.maxPathLength)}`)])).toMatch(/200 characters/);
  });

  it('rejects case-insensitive duplicates', () => {
    expect(errorOf([file('scripts/a.sh'), file('scripts/A.sh')])).toBe('scripts/A.sh: duplicate file');
  });

  it('rejects binary content', () => {
    expect(errorOf([file('scripts/a.bin', 'ab\u0000cd')])).toBe('scripts/a.bin: only text files are supported');
  });

  it('enforces the count, per-file and total byte limits', () => {
    const many = Array.from({ length: SKILL_FILE_LIMITS.maxFiles + 1 }, (_, i) => file(`references/${i}.md`));
    expect(errorOf(many)).toMatch(/at most 20/);

    // Multi-byte characters count as their UTF-8 bytes, not code units.
    const big = '\u00e9'.repeat(SKILL_FILE_LIMITS.maxFileBytes / 2 + 1);
    expect(errorOf([file('references/big.md', big)])).toBe('references/big.md: files must be 100 KB or smaller');

    const chunk = 'a'.repeat(SKILL_FILE_LIMITS.maxFileBytes);
    const sixChunks = Array.from({ length: 6 }, (_, i) => file(`references/${i}.md`, chunk));
    expect(errorOf(sixChunks)).toMatch(/total 512 KB/);
    expect(errorOf(sixChunks.slice(0, 5))).toBeNull();
  });

  it('rejects a path that is also a folder of another file', () => {
    expect(errorOf([file('scripts/a', 'x'), file('scripts/a/b.sh', 'x')])).toMatch(/both a file and a folder/);
    expect(errorOf([file('scripts/A', 'x'), file('scripts/a/b.sh', 'x')])).toMatch(/both a file and a folder/);
    // '-' and '.' sort before '/', so a sibling can sit between the file and its folder.
    expect(errorOf([file('scripts/a', 'x'), file('scripts/a-b', 'x'), file('scripts/a/b.sh', 'x')])).toMatch(
      /both a file and a folder/
    );
    expect(errorOf([file('scripts/a', 'x'), file('scripts/a.b', 'x'), file('scripts/a/b.sh', 'x')])).toMatch(
      /both a file and a folder/
    );
    expect(errorOf([file('scripts/a', 'x'), file('scripts/ab.sh', 'x')])).toBeNull();
  });

  it('rejects non-string paths and contents', () => {
    expect(errorOf([{ path: 1, content: 'x' } as never])).toMatch(/string path and content/);
    expect(errorOf([{ path: 'scripts/a.sh', content: 2 } as never])).toMatch(/string path and content/);
  });

  it('rejects nested traversal and hidden folders', () => {
    expect(errorOf([file('scripts/a/../../x', 'x')])).not.toBeNull();
    expect(errorOf([file('scripts/.hidden/x.sh', 'x')])).not.toBeNull();
  });
});
