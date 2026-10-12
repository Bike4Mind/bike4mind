import { describe, it, expect } from 'vitest';
import { displayReplyTitle, stripInlineMarkdown } from './plainTitle';

describe('stripInlineMarkdown', () => {
  it.each([
    ['Session 1 Recap: *Tides of the Drowned Crown*', 'Session 1 Recap: Tides of the Drowned Crown'],
    ['**Bold** and _italic_ and ~~gone~~', 'Bold and italic and gone'],
    ['Use `npm ci` here', 'Use npm ci here'],
    ['See [the docs](https://example.com/docs)', 'See the docs'],
    ['***Both***', 'Both'],
    ['Why `a*b*c` matters', 'Why a*b*c matters'],
    ['Run `*glob*` and *this*', 'Run *glob* and this'],
    ['See [docs](https://example.com/a_(b)) now', 'See docs now'],
    ['![diagram](https://example.com/x.png) overview', 'diagram overview'],
  ])('%j -> %j', (input, expected) => {
    expect(stripInlineMarkdown(input)).toBe(expected);
  });

  it.each(['snake_case_name stays', '5 * 3 = 15', 'Price: 2 * 4 * 6'])('leaves %j alone', input => {
    expect(stripInlineMarkdown(input)).toBe(input);
  });
});

describe('displayReplyTitle', () => {
  it('strips a title cut from the first line before the write path stripped markers', () => {
    expect(displayReplyTitle('Recap: *Tides*', '# Recap: *Tides*\n\nbody')).toBe('Recap: Tides');
  });

  it('keeps a caller-supplied title verbatim', () => {
    expect(displayReplyTitle('*Draft* v2', 'Some reply body')).toBe('*Draft* v2');
  });

  it('keeps an embedded artifact name verbatim', () => {
    const body = '<artifact identifier="a" type="text/html" title="my_tool_v2"><p>x</p></artifact>';
    expect(displayReplyTitle('my_tool_v2', body)).toBe('my_tool_v2');
  });
});
