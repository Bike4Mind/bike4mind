import { describe, expect, it } from 'vitest';
import { buildDiff, splitLines } from './diff';

describe('buildDiff', () => {
  it('reads a trailing newline as a terminator, not an extra line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  it('shows a created file as all additions', () => {
    const diff = buildDiff('/tmp/new.txt', 'create', '', 'one\ntwo\n');

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.lines.map(line => line.kind)).toEqual(['add', 'add']);
    expect(diff.lines[0].newLine).toBe(1);
  });

  // The behaviour the approval prompt lives or dies on: a one-line change in a long file has
  // to read as a one-line change, not as a wholesale replacement.
  it('isolates a single changed line and elides the rest', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 20', 'line twenty');
    const diff = buildDiff('/tmp/f.txt', 'edit', before, after);

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.some(line => line.kind === 'gap')).toBe(true);
    expect(diff.lines.filter(line => line.kind === 'remove')[0]).toMatchObject({ text: 'line 20', oldLine: 20 });
    expect(diff.lines.filter(line => line.kind === 'add')[0]).toMatchObject({ text: 'line twenty', newLine: 20 });
  });

  it('numbers both sides when lines are inserted', () => {
    const diff = buildDiff('/tmp/f.txt', 'edit', 'a\nb\n', 'a\nnew\nb\n');
    const added = diff.lines.filter(line => line.kind === 'add');

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ text: 'new', newLine: 2 });
    expect(added[0].oldLine).toBeUndefined();
    expect(diff.lines.filter(line => line.kind === 'context').map(line => line.text)).toEqual(['a', 'b']);
  });

  it('flags a change too large to render line by line', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n');
    const diff = buildDiff('/tmp/big.txt', 'overwrite', before, after);

    expect(diff.truncated).toBe(true);
    expect(diff.added).toBe(2000);
    expect(diff.removed).toBe(2000);
  });
});
