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

  it('ignores a fence marker that is not at the start of a line, leaving both it and an unrelated code block untouched', () => {
    // "```b4m_cards" appears mid-line here (after "see "), which is never a valid CommonMark
    // fence opener - an unanchored match would incorrectly treat it as one and delete everything
    // up to (and including) the unrelated ```js block that follows.
    const input = 'see ```b4m_cards inline and ```js\ncode\n``` end';
    expect(stripSearchResultCardFences(input)).toBe(input);
  });

  it('does not treat a backtick run embedded mid-line inside the card JSON as the closing fence', () => {
    const input = `Before.\n${'```b4m_cards\n{"note":"x```y"}\n```'}\nAfter.`;
    expect(stripSearchResultCardFences(input)).toBe('Before.\n\nAfter.');
  });

  it('requires a same-or-longer backtick run to close a longer opening fence, ignoring a shorter run inside the body', () => {
    const input = 'Before.\n````b4m_cards\n{"note":"```embedded```"}\n````\nAfter.';
    expect(stripSearchResultCardFences(input)).toBe('Before.\n\nAfter.');
  });
});

describe('stripSearchResultCardFences - b4m_map fences', () => {
  const MAP_FENCE = (body: string) => '```b4m_map\n' + body + '\n```';

  it('rewrites a map fence as a readable list in place, leaving card fences stripped', () => {
    const input = `Dinner ideas:\n\n${MAP_FENCE('{"places":[{"id":"ChIJa","name":"Barr"}]}')}\n\n${FENCE('{"cards":[]}')}\n\nEnjoy.`;
    expect(stripSearchResultCardFences(input)).toBe(
      'Dinner ideas:\n\n' +
        '- **Barr** ([Open in Google Maps](https://www.google.com/maps/search/?api=1&query=Barr&query_place_id=ChIJa))' +
        '\n\n\n\nEnjoy.'
    );
  });

  it('drops a malformed or unclosed map fence rather than leaking JSON', () => {
    expect(stripSearchResultCardFences(`A\n${MAP_FENCE('{"places":')}\nB`)).toBe('A\n\nB');
    expect(stripSearchResultCardFences('A\n```b4m_map\n{"places":[{"id"')).toBe('A\n');
  });
});
