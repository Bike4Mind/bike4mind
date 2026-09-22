import { describe, it, expect } from 'vitest';
import { parseSearchResultCards, SEARCH_RESULT_CARDS_LANGUAGE } from './parseSearchResultCards';

const image = (url: string, source?: string) => (source ? { url, source } : { url });

const block = (cards: unknown[]) => JSON.stringify({ cards });

describe('SEARCH_RESULT_CARDS_LANGUAGE', () => {
  // Both the reply renderer and the curation extractor capture the fence language with `\w+`, so a
  // hyphen here truncates it to `b4m` and the cards silently never render.
  it('contains only word characters, so the language regexes capture all of it', () => {
    expect(SEARCH_RESULT_CARDS_LANGUAGE).toMatch(/^\w+$/);
    expect(/language-(\w+)/.exec(`language-${SEARCH_RESULT_CARDS_LANGUAGE}`)?.[1]).toBe(SEARCH_RESULT_CARDS_LANGUAGE);
  });

  // `replyDownloads.ts` lowercases the captured language before comparing against this constant
  // (`infoString.split(/\s+/)[0]?.toLowerCase()`), so an uppercase-containing value would pass the
  // `\w`-only guard above while silently breaking that comparison and letting the card JSON through
  // as a downloadable file again.
  it('is already lowercase, so a case-sensitive equality check against it never silently breaks', () => {
    expect(SEARCH_RESULT_CARDS_LANGUAGE).toBe(SEARCH_RESULT_CARDS_LANGUAGE.toLowerCase());
  });
});

describe('parseSearchResultCards', () => {
  it('parses a well-formed block, keeping per-image attribution', () => {
    const parsed = parseSearchResultCards(
      block([
        {
          name: 'Orient Bambino',
          note: 'The default answer to this question.',
          meta: '~$200',
          url: 'https://orientwatch.co/bambino',
          images: [image('https://cdn.example.com/a.jpg', 'orientwatch.co')],
        },
      ])
    );

    expect(parsed).toEqual({
      state: 'ok',
      cards: [
        {
          name: 'Orient Bambino',
          note: 'The default answer to this question.',
          meta: '~$200',
          url: 'https://orientwatch.co/bambino',
          images: [{ url: 'https://cdn.example.com/a.jpg', source: 'orientwatch.co' }],
        },
      ],
    });
  });

  it("attributes a bare image string to its own host, not the card's link host", () => {
    const parsed = parseSearchResultCards(
      block([{ name: 'A', url: 'https://www.orientwatch.co/a', images: ['https://www.jomashop.com/a.jpg'] }])
    );

    expect(parsed).toMatchObject({
      state: 'ok',
      cards: [{ images: [{ url: 'https://www.jomashop.com/a.jpg', source: 'jomashop.com' }] }],
    });
  });

  it('prefers an explicit source over the derived host', () => {
    const parsed = parseSearchResultCards(
      block([{ name: 'A', images: [{ url: 'https://cdn.example.com/a.jpg', source: 'orientwatch.co' }] }])
    );

    expect(parsed).toMatchObject({ state: 'ok', cards: [{ images: [{ source: 'orientwatch.co' }] }] });
  });

  it.each([
    ['http (mixed content)', 'http://cdn.example.com/a.jpg'],
    ['data URI', 'data:image/png;base64,AAAA'],
    ['javascript URI', 'javascript:alert(1)'],
    ['not a URL', 'a.jpg'],
  ])('drops a card whose only image is a %s', (_label, url) => {
    expect(parseSearchResultCards(block([{ name: 'A', images: [url] }]))).toEqual({ state: 'invalid' });
  });

  it('drops cards with no name and cards with no usable image', () => {
    const parsed = parseSearchResultCards(
      block([
        { name: '  ', images: ['https://cdn.example.com/a.jpg'] },
        { name: 'No pictures', images: [] },
        { name: 'Keeper', images: ['https://cdn.example.com/b.jpg'] },
      ])
    );

    expect(parsed).toMatchObject({ state: 'ok', cards: [{ name: 'Keeper' }] });
  });

  it('dedupes repeated image URLs within a card', () => {
    const parsed = parseSearchResultCards(
      block([{ name: 'A', images: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg'] }])
    );

    expect(parsed).toMatchObject({ state: 'ok', cards: [{ images: [{ url: 'https://cdn.example.com/a.jpg' }] }] });
  });

  it('caps cards at 8 and images at 4 so one block cannot swamp the reply', () => {
    const images = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const cards = Array.from({ length: 12 }, (_, i) => ({ name: `Card ${i}`, images }));
    const parsed = parseSearchResultCards(block(cards));

    expect(parsed.state).toBe('ok');
    if (parsed.state !== 'ok') return;
    expect(parsed.cards).toHaveLength(8);
    expect(parsed.cards[0].images).toHaveLength(4);
  });

  it('rejects a non-https link target but keeps the card', () => {
    const parsed = parseSearchResultCards(
      block([{ name: 'A', url: 'javascript:alert(1)', images: ['https://cdn.example.com/a.jpg'] }])
    );

    expect(parsed).toMatchObject({ state: 'ok', cards: [{ url: undefined }] });
  });

  it('allows an http link target', () => {
    const parsed = parseSearchResultCards(
      block([{ name: 'A', url: 'http://example.com/a', images: ['https://cdn.example.com/a.jpg'] }])
    );

    expect(parsed).toMatchObject({ state: 'ok', cards: [{ url: 'http://example.com/a' }] });
  });

  describe('streaming', () => {
    it.each([
      ['empty', ''],
      ['opening brace only', '{'],
      ['mid-key', '{"cards":[{"name":"Orient Bam'],
      ['unclosed array', '{"cards":[{"name":"A","images":["https://cdn.example.com/a.jpg"]}'],
      ['brace inside an unterminated string', '{"cards":[{"name":"A }"'],
    ])('reports %s as pending rather than invalid', (_label, partial) => {
      expect(parseSearchResultCards(partial)).toEqual({ state: 'pending' });
    });

    it.each([
      ['balanced but nonsensical', '{"cards":[}]}'],
      ['over-closed', '{"cards":[]}}}'],
    ])('reports a %s block as invalid, never pending', (_label, content) => {
      expect(parseSearchResultCards(content)).toEqual({ state: 'invalid' });
    });

    it('is not fooled by a brace inside a string value', () => {
      const parsed = parseSearchResultCards(block([{ name: 'A { B }', images: ['https://cdn.example.com/a.jpg'] }]));
      expect(parsed).toMatchObject({ state: 'ok', cards: [{ name: 'A { B }' }] });
    });

    it('survives an escaped quote inside a string', () => {
      const parsed = parseSearchResultCards(
        block([{ name: 'A "quoted" B', images: ['https://cdn.example.com/a.jpg'] }])
      );
      expect(parsed).toMatchObject({ state: 'ok', cards: [{ name: 'A "quoted" B' }] });
    });
  });

  it.each([
    ['a JSON array', '[]'],
    ['a JSON scalar', '"hello"'],
    ['an object with no cards key', '{"foo":1}'],
    ['cards that is not an array', '{"cards":{}}'],
    ['an empty cards array', '{"cards":[]}'],
  ])('reports %s as invalid', (_label, content) => {
    expect(parseSearchResultCards(content)).toEqual({ state: 'invalid' });
  });
});
