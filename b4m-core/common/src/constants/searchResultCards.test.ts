import { describe, it, expect } from 'vitest';
import { stripSearchResultCardFences } from './searchResultCards';

const FENCE = (body: string) => '```b4m_cards\n' + body + '\n```';

describe('stripSearchResultCardFences', () => {
  it('removes a single closed fence', () => {
    const input = `Here is your answer.\n\n${FENCE('{"cards":[]}')}\n\nHope that helps.`;
    expect(stripSearchResultCardFences(input)).toBe('Here is your answer.\n\n\n\nHope that helps.');
  });

  it('removes multiple closed fences', () => {
    const input = `A\n${FENCE('{"cards":[1]}')}\nB\n${FENCE('{"cards":[2]}')}\nC`;
    expect(stripSearchResultCardFences(input)).toBe('A\n\nB\n\nC');
  });

  it('drops from an unclosed fence to end of string', () => {
    const input = 'Prose before.\n\n```b4m_cards\n{"cards": [{"name": "trunc';
    expect(stripSearchResultCardFences(input)).toBe('Prose before.\n\n');
  });

  it('drops from an unclosed fence to end of string even with no trailing newline after the language', () => {
    const input = 'Prose before.\n\n```b4m_cards';
    expect(stripSearchResultCardFences(input)).toBe('Prose before.\n\n');
  });

  it('is a no-op when there is no fence', () => {
    const input = 'Just plain prose with no cards at all.';
    expect(stripSearchResultCardFences(input)).toBe(input);
  });

  it('preserves surrounding prose before and after an embedded fence', () => {
    const input = `Before text.\n${FENCE('{"cards":[]}')}\nAfter text.`;
    expect(stripSearchResultCardFences(input)).toBe('Before text.\n\nAfter text.');
  });

  it('does not touch an unrelated fenced code block', () => {
    const input = 'Some code:\n```js\nconsole.log(1);\n```\nDone.';
    expect(stripSearchResultCardFences(input)).toBe(input);
  });
});
