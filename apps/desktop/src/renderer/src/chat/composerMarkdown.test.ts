import { describe, expect, it } from 'vitest';
import { caretInCode, codeRanges, fenceKeyAction, type ComposerEdit } from './composerMarkdown';

const key = (
  name: string,
  mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}
) => ({
  key: name,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

const at = (text: string, selectionStart: number, selectionEnd = selectionStart) => ({
  text,
  selectionStart,
  selectionEnd,
});

/** Apply an edit the way Composer does, returning the new text and selection. */
function apply(text: string, edit: ComposerEdit) {
  return {
    text: text.slice(0, edit.start) + edit.insert + text.slice(edit.end),
    selection: [edit.selectionStart, edit.selectionEnd],
  };
}

function editFor(...args: Parameters<typeof fenceKeyAction>) {
  const action = fenceKeyAction(...args);
  if (action.kind !== 'edit') throw new Error(`expected an edit, got ${action.kind}`);
  return apply(args[1].text, action.edit);
}

describe('codeRanges', () => {
  it('finds an inline span, backticks included', () => {
    expect(codeRanges('use `x` here')).toEqual([{ kind: 'inline', start: 4, end: 7 }]);
  });

  it('matches a double-backtick span that contains a single backtick', () => {
    expect(codeRanges('a ``b`c`` d')).toEqual([{ kind: 'inline', start: 2, end: 9 }]);
  });

  it('leaves an unmatched backtick unpainted', () => {
    expect(codeRanges('it`s fine')).toEqual([]);
  });

  it('finds a closed fenced block from its opening line to its closing one', () => {
    const text = 'look:\n```ts\nconst a = 1\n```\nafter `b`';
    expect(codeRanges(text)).toEqual([
      { kind: 'block', start: 6, end: 27 },
      { kind: 'inline', start: 34, end: 37 },
    ]);
  });

  it('runs a block still being typed to the end of the draft', () => {
    expect(codeRanges('```\nfoo')).toEqual([{ kind: 'block', start: 0, end: 7 }]);
  });

  it('does not paint backticks inside a block as inline spans', () => {
    expect(codeRanges('```\n`x`\n```')).toEqual([{ kind: 'block', start: 0, end: 11 }]);
  });

  it('needs a closing fence at least as long as the opening one', () => {
    expect(codeRanges('````\nx\n```')).toEqual([{ kind: 'block', start: 0, end: 10 }]);
    expect(codeRanges('```\nx\n````')).toEqual([{ kind: 'block', start: 0, end: 10 }]);
  });

  it('does not treat a four-space-indented fence or a tilde fence as a block', () => {
    expect(codeRanges('    ```\nx')).toEqual([]);
    expect(codeRanges('~~~\nx\n~~~')).toEqual([]);
  });
});

describe('caretInCode', () => {
  it('is true between the backticks of a span and false on its edges', () => {
    expect(caretInCode('see `/path` x', 6)).toBe(true);
    expect(caretInCode('see `/path` x', 4)).toBe(false);
    expect(caretInCode('see `/path` x', 11)).toBe(false);
  });

  it('is true inside an open block and false after it closes', () => {
    expect(caretInCode('```\n/', 5)).toBe(true);
    expect(caretInCode('```\nx\n```\n/', 11)).toBe(false);
  });
});

describe('fenceKeyAction', () => {
  it('leaves every key alone outside a block', () => {
    expect(fenceKeyAction(key('Enter'), at('hello', 5), false)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Tab'), at('hello', 5), false)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Enter', { metaKey: true }), at('hello', 5), false)).toEqual({ kind: 'default' });
  });

  it('leaves Enter alone just after a typed closing fence', () => {
    expect(fenceKeyAction(key('Enter'), at('```\nfoo\n```', 11), false)).toEqual({ kind: 'default' });
  });

  it('auto-closes a fresh fence on Enter, caret on the empty line between', () => {
    expect(editFor(key('Enter'), at('```ts', 5), false)).toEqual({ text: '```ts\n\n```', selection: [6, 6] });
  });

  it('closes with as many backticks as the fence opened with', () => {
    expect(editFor(key('Enter'), at('````', 4), false).text).toBe('````\n\n````');
  });

  it('does not add a second closing fence when the block is already closed', () => {
    expect(editFor(key('Enter'), at('```\n\n```', 3), false)).toEqual({ text: '```\n\n\n```', selection: [4, 4] });
  });

  it('breaks the line instead of sending inside a block, keeping its indent', () => {
    expect(editFor(key('Enter'), at('```\nfoo\n```', 7), false)).toEqual({
      text: '```\nfoo\n\n```',
      selection: [8, 8],
    });
    expect(editFor(key('Enter'), at('```\n  foo', 9), false)).toEqual({ text: '```\n  foo\n  ', selection: [12, 12] });
  });

  it('sends on Cmd or Ctrl+Enter inside a block', () => {
    expect(fenceKeyAction(key('Enter', { metaKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'submit' });
    expect(fenceKeyAction(key('Enter', { ctrlKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'submit' });
  });

  it('leaves Shift+Enter to the textarea inside a block', () => {
    expect(fenceKeyAction(key('Enter', { shiftKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'default' });
  });

  it('indents at the caret on Tab', () => {
    expect(editFor(key('Tab'), at('```\nfoo', 4), false)).toEqual({ text: '```\n  foo', selection: [6, 6] });
  });

  it('indents every selected line on Tab', () => {
    expect(editFor(key('Tab'), at('```\na\nb', 4, 7), false)).toEqual({ text: '```\n  a\n  b', selection: [6, 11] });
  });

  it('outdents the line on Shift+Tab', () => {
    expect(editFor(key('Tab', { shiftKey: true }), at('```\n  foo', 9), false)).toEqual({
      text: '```\nfoo',
      selection: [7, 7],
    });
  });

  it('swallows Shift+Tab on a line with nothing to outdent, so focus does not jump', () => {
    expect(fenceKeyAction(key('Tab', { shiftKey: true }), at('```\nfoo', 7), false)).toEqual({ kind: 'consume' });
  });

  // Escape then Tab is the way out of a block; without it Tab would be a keyboard trap.
  it('hands Tab back to focus navigation right after Escape', () => {
    expect(fenceKeyAction(key('Tab'), at('```\nfoo', 7), true)).toEqual({ kind: 'default' });
    expect(fenceKeyAction(key('Tab', { shiftKey: true }), at('```\n  foo', 9), true)).toEqual({ kind: 'default' });
  });
});
