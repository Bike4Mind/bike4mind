import { describe, expect, it } from 'vitest';
import { clampQuote, QUOTE_LIMIT, quotedMessage } from './quotedReply';

describe('quotedMessage', () => {
  it('puts the quote under "Regarding:" as a blockquote, then the message', () => {
    expect(quotedMessage('first line\nsecond line', 'Why?')).toBe('Regarding:\n> first line\n> second line\n\nWhy?');
  });

  it('leaves no trailing space on a blank quoted line', () => {
    expect(quotedMessage('a\n\nb', 'ok')).toBe('Regarding:\n> a\n>\n> b\n\nok');
  });

  it('keeps a skill invocation first, so the skill still runs with the quote in its arguments', () => {
    expect(quotedMessage('passage', '/explain simply')).toBe('/explain simply\n\nRegarding:\n> passage');
    expect(quotedMessage('passage', '/my-skill')).toBe('/my-skill\n\nRegarding:\n> passage');
  });

  it('does not treat a path or a lone slash as a skill', () => {
    expect(quotedMessage('passage', '/ what?')).toBe('Regarding:\n> passage\n\n/ what?');
  });
});

describe('clampQuote', () => {
  it('trims, and cuts an over-long highlight with a marker', () => {
    expect(clampQuote('  short  ')).toBe('short');
    const long = 'x'.repeat(QUOTE_LIMIT + 50);
    expect(clampQuote(long)).toBe(`${'x'.repeat(QUOTE_LIMIT)} [...]`);
  });
});
