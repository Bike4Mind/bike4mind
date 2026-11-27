import { describe, expect, it } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { normalizeUrl, UrlProvenance, urlsIn } from './urlProvenance';

describe('normalizeUrl', () => {
  it('drops prose punctuation, unbalanced brackets and a trailing slash', () => {
    expect(normalizeUrl('https://example.com/a/.')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a),')).toBe('https://example.com/a');
    expect(normalizeUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(normalizeUrl('https://example.com/?a=1&amp;b=2')).toBe('https://example.com/?a=1&b=2');
  });
});

describe('urlsIn', () => {
  it('finds URLs in nested values', () => {
    expect(urlsIn({ a: ['see https://a.test/x', { b: 'http://b.test/y]' }] })).toEqual(
      new Set(['https://a.test/x', 'http://b.test/y'])
    );
  });
});

describe('UrlProvenance', () => {
  it('allows a URL only as it appeared, never a longer one built on it', () => {
    const provenance = new UrlProvenance();
    provenance.recordText('Summarize https://example.com/report (thanks)');

    expect(provenance.allows('https://example.com/report')).toBe(true);
    expect(provenance.allows('https://example.com/report/')).toBe(true);
    expect(provenance.allows('https://example.com/report?leak=1')).toBe(false);
    expect(provenance.allows('https://example.com/report/leak')).toBe(false);
    expect(provenance.allows('https://other.test/')).toBe(false);
  });

  it('does not let a tool result vouch for a URL its own call passed in', () => {
    const provenance = new UrlProvenance();
    provenance.recordToolResult(
      'web_search',
      { query: 'https://attacker.test/?d=secret' },
      'Results for https://attacker.test/?d=secret: https://docs.test/page'
    );

    expect(provenance.allows('https://attacker.test/?d=secret')).toBe(false);
    expect(provenance.allows('https://docs.test/page')).toBe(true);
  });

  it('ignores the results of tools whose output the model wrote', () => {
    const provenance = new UrlProvenance();
    provenance.recordToolResult('prompt_enhancement', { prompt: 'x' }, 'https://made-up.test/');
    expect(provenance.allows('https://made-up.test/')).toBe(false);
  });

  it('seeds from messages, skipping the model and pairing results with their calls', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'Docs live at https://docs.test/' },
      { role: 'user', content: [{ type: 'text', text: 'Read https://user.test/a' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will fetch https://model.test/?x=secret' },
          { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'https://echo.test/q' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'https://echo.test/q and https://found.test/b' }],
      },
    ];
    const provenance = new UrlProvenance();
    provenance.recordMessages(messages);

    expect(provenance.allows('https://docs.test')).toBe(true);
    expect(provenance.allows('https://user.test/a')).toBe(true);
    expect(provenance.allows('https://found.test/b')).toBe(true);
    expect(provenance.allows('https://model.test/?x=secret')).toBe(false);
    expect(provenance.allows('https://echo.test/q')).toBe(false);
  });
});
