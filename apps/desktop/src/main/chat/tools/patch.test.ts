import { describe, expect, it } from 'vitest';
import { applyChunks, parsePatch, PatchParseError, seekSequence } from './patch';

const wrap = (...body: string[]): string => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

function updateChunks(...body: string[]) {
  const [op] = parsePatch(wrap('*** Update File: a.ts', ...body));
  if (op.kind !== 'update') throw new Error('expected an update');
  return op.chunks;
}

describe('parsePatch', () => {
  it('reads add, delete, update and move across several files', () => {
    const ops = parsePatch(
      wrap(
        '*** Add File: hello.txt',
        '+Hello',
        '+',
        '+world',
        '*** Update File: src/app.py',
        '*** Move to: src/main.py',
        '@@ def greet():',
        '-print("Hi")',
        '+print("Hello")',
        '*** Delete File: obsolete.txt'
      )
    );

    expect(ops).toEqual([
      { kind: 'add', path: 'hello.txt', lines: ['Hello', '', 'world'] },
      {
        kind: 'update',
        path: 'src/app.py',
        moveTo: 'src/main.py',
        chunks: [
          {
            anchors: ['def greet():'],
            oldLines: ['print("Hi")'],
            newLines: ['print("Hello")'],
            body: [
              { mark: '-', text: 'print("Hi")' },
              { mark: '+', text: 'print("Hello")' },
            ],
            addedLines: ['print("Hello")'],
            endOfFile: false,
          },
        ],
      },
      { kind: 'delete', path: 'obsolete.txt' },
    ]);
  });

  it('splits hunks on @@ and keeps context in both sides', () => {
    const chunks = updateChunks('@@ one', ' keep', '-old', '+new', '@@ two', '-x', '+y');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ anchors: ['one'], oldLines: ['keep', 'old'], newLines: ['keep', 'new'] });
    expect(chunks[1]).toMatchObject({ anchors: ['two'], oldLines: ['x'], newLines: ['y'] });
  });

  it('allows the first hunk to omit its @@ header', () => {
    const chunks = updateChunks('-old', '+new');
    expect(chunks[0].anchors).toEqual([]);
    expect(chunks[0].oldLines).toEqual(['old']);
  });

  it('chains consecutive @@ lines into one hunk with several anchors', () => {
    const chunks = updateChunks('@@ class A', '@@   def run(self):', '-x', '+y');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].anchors).toEqual(['class A', 'def run(self):']);
  });

  it('marks a hunk that ends with the end-of-file marker', () => {
    const chunks = updateChunks('@@', ' last', '+appended', '*** End of File');
    expect(chunks[0].endOfFile).toBe(true);
    expect(chunks[0].newLines).toEqual(['last', 'appended']);
  });

  it('treats a bare empty line as blank context, but drops blanks before the next section', () => {
    const [update, next] = parsePatch(
      wrap('*** Update File: a.ts', '-a', '', '-b', '+c', '', '*** Update File: b.ts', '-z', '+y')
    );
    expect(update.kind === 'update' && update.chunks[0]).toMatchObject({
      oldLines: ['a', '', 'b'],
      newLines: ['', 'c'],
    });
    expect(next.kind).toBe('update');
  });

  it('unwraps a heredoc, quoted or not, and CRLF line breaks', () => {
    const body = wrap('*** Add File: a.txt', '+x');
    for (const text of [
      `cat <<'EOF'\n${body}\nEOF`,
      `<<EOF\n${body}\nEOF\n`,
      `apply_patch <<"PATCH"\n${body}\nPATCH`,
    ]) {
      expect(parsePatch(text)).toEqual([{ kind: 'add', path: 'a.txt', lines: ['x'] }]);
    }
    expect(parsePatch(body.replace(/\n/g, '\r\n'))).toEqual([{ kind: 'add', path: 'a.txt', lines: ['x'] }]);
  });

  it('accepts a pure rename with no hunks', () => {
    expect(parsePatch(wrap('*** Update File: a.ts', '*** Move to: b.ts'))).toEqual([
      { kind: 'update', path: 'a.ts', moveTo: 'b.ts', chunks: [] },
    ]);
  });

  describe('malformed input', () => {
    const fails = (text: string): string => {
      try {
        parsePatch(text);
      } catch (error) {
        expect(error).toBeInstanceOf(PatchParseError);
        return (error as Error).message;
      }
      throw new Error('expected a parse error');
    };

    it('needs both envelope lines', () => {
      expect(fails('*** Add File: a\n+x\n*** End Patch')).toMatch(/Begin Patch/);
      expect(fails('*** Begin Patch\n*** Add File: a\n+x')).toMatch(/End Patch/);
    });

    it('rejects an unknown header and names the line', () => {
      expect(fails(wrap('*** Rename File: a.ts'))).toMatch(/Line 1: expected "\*\*\* Add File:/);
    });

    it('rejects a header with no path', () => {
      expect(fails(wrap('*** Delete File:'))).toMatch(/needs a path/);
    });

    it('rejects an Add File line that is not a + line', () => {
      expect(fails(wrap('*** Add File: a.ts', '+ok', 'oops'))).toMatch(/Line 3: every line of an Add File section/);
    });

    it('rejects a hunk line with no marker', () => {
      expect(fails(wrap('*** Update File: a.ts', '@@', 'no marker'))).toMatch(/must start with " "/);
    });

    it('rejects an update with no hunks and an empty hunk', () => {
      expect(fails(wrap('*** Update File: a.ts'))).toMatch(/no hunks/);
      expect(fails(wrap('*** Update File: a.ts', '@@ x', '@@ y'))).toMatch(/no lines/);
    });
  });
});

describe('seekSequence', () => {
  it('searches forward from the start index, so a repeated line resolves by order', () => {
    const lines = ['});', 'a', '});', 'b', '});'];
    expect(seekSequence(lines, ['});'], 0)?.index).toBe(0);
    expect(seekSequence(lines, ['});'], 1)?.index).toBe(2);
    expect(seekSequence(lines, ['});'], 3)?.index).toBe(4);
    expect(seekSequence(lines, ['});'], 5)).toBeNull();
  });

  it('tries the end of the file first for an end-of-file hunk', () => {
    const lines = ['x', 'y', 'x', 'y'];
    expect(seekSequence(lines, ['x', 'y'], 0, true)?.index).toBe(2);
  });

  it('reports which comparison matched', () => {
    expect(seekSequence(['foo()'], ['foo()'], 0)?.level).toBe('exact');
    expect(seekSequence(['foo()   '], ['foo()'], 0)?.level).toBe('trimEnd');
    expect(seekSequence(['    foo()'], ['foo()'], 0)?.level).toBe('trim');
    expect(seekSequence(['say \u201Chi\u201D'], ['say "hi"'], 0)?.level).toBe('unicode');
  });

  it('prefers an exact match later in the file over a looser one earlier', () => {
    expect(seekSequence(['  x', 'x'], ['x'], 0)).toEqual({ index: 1, level: 'exact' });
  });
});

describe('applyChunks', () => {
  const run = (file: string[], ...body: string[]) => applyChunks(file, updateChunks(...body));

  it('applies the repeated-closer case by hunk order', () => {
    const file = ['it("a", () => {', '  one();', '});', '', 'it("b", () => {', '  two();', '});'];
    const result = run(file, '@@', '-  one();', '+  uno();', ' });', '@@', '-  two();', '+  dos();', ' });');
    expect(result.failures).toEqual([]);
    expect(result.lines).toEqual(['it("a", () => {', '  uno();', '});', '', 'it("b", () => {', '  dos();', '});']);
  });

  it('uses @@ anchors to reach the right occurrence', () => {
    const file = ['function a() {', '  return 1;', '}', 'function b() {', '  return 1;', '}'];
    const result = run(file, '@@ function b() {', '-  return 1;', '+  return 2;');
    expect(result.lines[1]).toBe('  return 1;');
    expect(result.lines[4]).toBe('  return 2;');
  });

  it('applies hunks tolerant of trailing whitespace and indentation, and says how far it bent', () => {
    const trailing = run(['a   ', 'b'], '-a', '+A');
    expect(trailing.lines).toEqual(['A', 'b']);
    expect(trailing.loosest).toBe('trimEnd');

    const indent = run(['  a', 'b'], '-a', '+A');
    expect(indent.lines).toEqual(['A', 'b']);
    expect(indent.loosest).toBe('trim');

    expect(run(['a'], '-a', '+b').loosest).toBe('exact');
  });

  it('appends a hunk with no old lines at the end of the file', () => {
    expect(run(['a', 'b'], '+c').lines).toEqual(['a', 'b', 'c']);
  });

  it('retries without a trailing blank line', () => {
    const result = run(['a', 'b'], '-a', '+A', ' b', ' ', '*** End of File');
    expect(result.failures).toEqual([]);
    expect(result.lines).toEqual(['A', 'b']);
  });

  describe('failures', () => {
    it('quotes the expected lines and gives the nearest line', () => {
      const file = ['alpha', 'beta', 'gamma', 'delta'];
      const { failures } = run(file, '-beta', '-gamma changed', '+x');
      expect(failures).toHaveLength(1);
      expect(failures[0].hunk).toBe(1);
      expect(failures[0].message).toContain('hunk 1 of 1: could not find these lines:\nbeta\ngamma changed');
      expect(failures[0].message).toContain('its first line at line 2');
      expect(failures[0].message).toContain('2\tbeta\n3\tgamma');
    });

    it('says when the text only occurs before the previous hunk', () => {
      const file = [
        'const first = loadFirstValue();',
        'const second = loadSecondValue();',
        'const third = loadThirdValue();',
      ];
      const { failures } = run(
        file,
        '-const third = loadThirdValue();',
        '+const third = 3;',
        '@@',
        '-const first = loadFirstValue();',
        '+const first = 1;'
      );
      expect(failures).toHaveLength(1);
      expect(failures[0].hunk).toBe(2);
      expect(failures[0].message).toMatch(/appears only at line 1, before where the previous hunk ended \(line 3\)/);
    });

    it('gives no out-of-order hint when only a generic line matches earlier', () => {
      const file = [
        'useEffect(() => {',
        '  syncSomething();',
        '}, []);',
        'function later() {',
        '  return computeLaterValue();',
        '}',
      ];
      const { failures } = run(
        file,
        '-  return computeLaterValue();',
        '+  return 1;',
        '@@',
        ' useEffect(() => {',
        '-  doesNotExistAnywhere();',
        '+  other();'
      );
      expect(failures).toHaveLength(1);
      expect(failures[0].message).not.toMatch(/before where the previous hunk ended/);
      expect(failures[0].message).toMatch(/None of those lines appear/);
    });

    it('points at the other file a hunk was written for', () => {
      const target = ['export function Chat() {', '  return null;', '}'];
      const explorer = ['useEffect(() => {', '  openArticle(deepLinkTarget.id);', '}, [deepLinkTarget]);'];
      const unrelated = ['const nothing = 1;'];
      const body = ['@@', ' useEffect(() => {', '-  openArticle(deepLinkTarget.id);', '+  openArticle(target.id);'];
      const { failures } = applyChunks(target, updateChunks(...body), [
        { display: 'apps/client/Unrelated.tsx', lines: unrelated },
        { display: 'apps/client/Explorer.tsx', lines: explorer },
      ]);
      expect(failures[0].message).toContain(
        'These lines are in apps/client/Explorer.tsx; did you mean to patch that file?'
      );
    });

    it('does not guess when the lines are in no other file, or in several', () => {
      const target = ['export function Chat() {', '  return null;', '}'];
      const body = ['-  openArticle(deepLinkTarget.id);', '+  openArticle(target.id);'];
      const lines = ['  openArticle(deepLinkTarget.id);'];
      const none = applyChunks(target, updateChunks(...body), [{ display: 'a.tsx', lines: ['const x = 1;'] }]);
      expect(none.failures[0].message).not.toContain('did you mean');
      expect(none.failures[0].message).toMatch(/None of those lines appear/);

      const two = applyChunks(target, updateChunks(...body), [
        { display: 'a.tsx', lines },
        { display: 'b.tsx', lines },
      ]);
      expect(two.failures[0].message).not.toContain('did you mean');
    });

    it('names a missing anchor', () => {
      const { failures } = run(['a'], '@@ function nope()', '-a', '+b');
      expect(failures[0].message).toMatch(/"@@" context: could not find these lines:\nfunction nope\(\)/);
      expect(failures[0].message).toMatch(/None of those lines appear/);
    });

    it('reports every failing hunk, not just the first', () => {
      const { failures } = run(['a', 'b'], '-x', '+1', '@@', '-y', '+2');
      expect(failures.map(failure => failure.hunk)).toEqual([1, 2]);
    });
  });
});
