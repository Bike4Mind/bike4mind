import { describe, expect, it } from 'vitest';
import { escapeSlackCode, escapeSlackLine, escapeSlackText } from './slackText';

describe('escapeSlackText', () => {
  it('neutralizes mentions and links', () => {
    expect(escapeSlackText('<!channel> see <https://x.test|y>')).toBe('&lt;!channel&gt; see &lt;https://x.test|y&gt;');
  });

  it('escapes ampersand before angle brackets so nothing double-encodes', () => {
    expect(escapeSlackText('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('keeps line breaks and emphasis characters', () => {
    expect(escapeSlackText('*bold*\nsnake_case')).toBe('*bold*\nsnake_case');
  });
});

describe('escapeSlackLine', () => {
  it('collapses every line terminator to a space', () => {
    expect(escapeSlackLine('a\r\nb\nc\td\u2028e')).toBe('a b c d e');
  });

  it('escapes like escapeSlackText', () => {
    expect(escapeSlackLine('<@U123>')).toBe('&lt;@U123&gt;');
  });
});

describe('escapeSlackCode', () => {
  it('replaces backticks so the value cannot close its code span', () => {
    expect(escapeSlackCode('a` <!here> `b')).toBe('a\u02CB &lt;!here&gt; \u02CBb');
  });

  it('collapses line breaks', () => {
    expect(escapeSlackCode('src/a.ts\nsrc/b.ts')).toBe('src/a.ts src/b.ts');
  });
});
