import { describe, it, expect } from 'vitest';
import { fuzzyMatch, isDisproportionate, AmbiguousMatchError, DisproportionateMatchError } from './fuzzyMatch';

/** Applies a fuzzy match and returns the resulting file content (or throws). */
function applyFuzzy(content: string, oldString: string, newString: string): string | null {
  const result = fuzzyMatch(content, oldString, newString);
  if (!result) return null;
  expect(content.includes(result.matchedText)).toBe(true); // safety invariant
  return (
    content.slice(0, result.startIndex) +
    result.replacement +
    content.slice(result.startIndex + result.matchedText.length)
  );
}

describe('fuzzyMatch', () => {
  describe('no match', () => {
    it('returns null when nothing resembles old_string', () => {
      const content = 'const a = 1;\nconst b = 2;\n';
      expect(fuzzyMatch(content, 'totally unrelated line', 'x')).toBeNull();
    });

    it('returns null when a single line differs by real content, not whitespace', () => {
      const content = 'function foo() {\n  return 1;\n}\n';
      // "return 2" is a genuine content difference, not drift.
      expect(fuzzyMatch(content, 'function foo() {\n  return 2;\n}', 'x')).toBeNull();
    });
  });

  describe('line-trimmed (indentation drift)', () => {
    it('matches a block whose leading indentation differs', () => {
      const content = ['function outer() {', '      const value = compute();', '      return value;', '}'].join('\n');
      // Model remembered the body at 2-space indent instead of the file's 6.
      const oldString = ['  const value = compute();', '  return value;'].join('\n');
      const newString = ['  const value = recompute();', '  return value * 2;'].join('\n');

      const result = applyFuzzy(content, oldString, newString);
      expect(result).toBe(
        ['function outer() {', '      const value = recompute();', '      return value * 2;', '}'].join('\n')
      );
    });

    it('preserves the file indentation by re-shaping new_string with the indent delta', () => {
      const content = ['class A {', '        doThing() {', '            run();', '        }', '}'].join('\n');
      const oldString = ['  doThing() {', '      run();', '  }'].join('\n');
      const newString = ['  doThing() {', '      run();', '      cleanup();', '  }'].join('\n');

      const result = applyFuzzy(content, oldString, newString);
      // The +6 indent delta is applied uniformly, so cleanup() lands at file depth.
      expect(result).toBe(
        ['class A {', '        doThing() {', '            run();', '            cleanup();', '        }', '}'].join(
          '\n'
        )
      );
    });
  });

  describe('whitespace-run width', () => {
    it('matches when internal whitespace width differs', () => {
      const content = 'const  x   =    1;\n';
      const oldString = 'const x = 1;';
      const result = applyFuzzy(content, oldString, 'const x = 2;');
      expect(result).toBe('const x = 2;\n');
    });
  });

  describe('blank-line boundary', () => {
    it('matches when old_string has an extra leading/trailing blank line', () => {
      const content = ['const a = 1;', 'const b = 2;'].join('\n');
      const oldString = ['', 'const a = 1;', 'const b = 2;', ''].join('\n');
      const newString = ['', 'const a = 10;', 'const b = 20;', ''].join('\n');

      const result = applyFuzzy(content, oldString, newString);
      expect(result).toBe(['const a = 10;', 'const b = 20;'].join('\n'));
    });
  });

  describe('escape-normalized', () => {
    it('matches when the model sent literal \\n / \\t escapes', () => {
      const content = 'if (x) {\n\treturn true;\n}\n';
      const oldString = 'if (x) {\\n\\treturn true;\\n}';
      const result = applyFuzzy(content, oldString, 'if (x) {\n\treturn false;\n}');
      expect(result).toBe('if (x) {\n\treturn false;\n}\n');
    });

    it('matches when the model sent an escaped double-quote', () => {
      const content = 'const s = "hello";\n';
      const oldString = 'const s = \\"hello\\";';
      const result = applyFuzzy(content, oldString, 'const s = "world";');
      expect(result).toBe('const s = "world";\n');
    });
  });

  describe('block-anchor (interior drift)', () => {
    it('matches on first/last line when an interior line drifted slightly', () => {
      const content = ['function calc() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}'].join('\n');
      // Interior "const b = 2" is dropped from old_string; anchors + similarity carry it.
      const oldString = ['function calc() {', '  const a = 1;', '  return a + b;', '}'].join('\n');
      const newString = ['function calc() {', '  return 42;', '}'].join('\n');

      const result = applyFuzzy(content, oldString, newString);
      expect(result).toBe(['function calc() {', '  return 42;', '}'].join('\n'));
    });
  });

  describe('CRLF preservation', () => {
    it('rewrites new_string line endings to the file CRLF', () => {
      const content = 'const a = 1;\r\nconst b = 2;\r\n';
      const oldString = 'const a = 1;\nconst b = 2;';
      const result = applyFuzzy(content, oldString, 'const a = 9;\nconst b = 8;');
      expect(result).toBe('const a = 9;\r\nconst b = 8;\r\n');
    });
  });

  describe('ambiguity guard', () => {
    it('throws when a trimmed block matches two distinct locations', () => {
      const content = ['  doThing();', 'divider', '    doThing();'].join('\n');
      expect(() => fuzzyMatch(content, 'doThing();', 'doOther();')).toThrow(AmbiguousMatchError);
    });

    it('throws when the escaped form occurs more than once', () => {
      const content = 'a\tb\na\tb\n';
      expect(() => fuzzyMatch(content, 'a\\tb', 'x')).toThrow(AmbiguousMatchError);
    });
  });

  describe('disproportion guard', () => {
    it('isDisproportionate flags spans far larger than old_string', () => {
      expect(isDisproportionate(50, 40)).toBe(false); // under the ratio
      expect(isDisproportionate(300, 250)).toBe(false); // under the ratio
      expect(isDisproportionate(300, 50)).toBe(true); // large and > 3x
    });

    it('refuses an anchor match that bridges a disproportionately large region', () => {
      // The interior "a()" / "b()" lines line up (similarity stays above
      // threshold), so the anchor matcher fires -- but a single huge interior
      // line makes the resolved span far larger than old_string.
      const huge = `  const bloat = ${'y'.repeat(300)};`;
      const content = ['open() {', '  a();', huge, '  b();', '}'].join('\n');
      const oldString = ['open() {', '  a();', '  b();', '}'].join('\n');
      expect(() => fuzzyMatch(content, oldString, 'open() {\n}')).toThrow(DisproportionateMatchError);
    });

    it('refuses (rather than silently applying) an anchor block that resolves into a larger span in a small file', () => {
      // Reproducer: old_string's anchors match the first block, but its lone
      // interior line ("b;") only appears in the *second* block. The one window
      // that survives interior matching spans both blocks -- it must not be
      // silently accepted just because the file is small.
      const content = ['if (x) {', '  a;', '}', 'if (y) {', '  b;', '}'].join('\n');
      const oldString = ['if (x) {', '  b;', '}'].join('\n');
      expect(fuzzyMatch(content, oldString, 'REPLACED')).toBeNull();
    });
  });

  describe('exact substring invariant', () => {
    it('always reports a matchedText that literally occurs in the content', () => {
      const content = ['function outer() {', '      const value = compute();', '}'].join('\n');
      const result = fuzzyMatch(content, '  const value = compute();', '  const value = x();');
      expect(result).not.toBeNull();
      expect(content.includes(result!.matchedText)).toBe(true);
    });
  });
});
