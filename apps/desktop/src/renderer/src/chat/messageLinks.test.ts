import { describe, expect, it } from 'vitest';
import { splitLinks } from './messageLinks';

const links = (text: string) => splitLinks(text).flatMap(segment => (segment.kind === 'link' ? [segment.href] : []));

describe('splitLinks', () => {
  it('links an http and an https url inside prose', () => {
    expect(links('see http://example.com and https://example.com/a?b=c#d for more')).toEqual([
      'http://example.com',
      'https://example.com/a?b=c#d',
    ]);
  });

  it('links a mailto address written out', () => {
    expect(links('write to mailto:someone@example.com today')).toEqual(['mailto:someone@example.com']);
  });

  it('loses nothing: the segments join back into the input', () => {
    const text = 'One (https://x.com/a), two https://y.com/b. Done!';
    expect(
      splitLinks(text)
        .map(segment => segment.text)
        .join('')
    ).toBe(text);
  });

  it('returns plain text untouched as one segment', () => {
    expect(splitLinks('no links in some_file_name here')).toEqual([
      { kind: 'text', text: 'no links in some_file_name here' },
    ]);
  });

  describe('trailing punctuation', () => {
    it.each([
      ['https://x.com/a.', 'https://x.com/a'],
      ['https://x.com/a,', 'https://x.com/a'],
      ['https://x.com/a?', 'https://x.com/a'],
      ['https://x.com/a!', 'https://x.com/a'],
      ['https://x.com/a:', 'https://x.com/a'],
      ['https://x.com/a;', 'https://x.com/a'],
      ["'https://x.com/a'", 'https://x.com/a'],
      ['https://x.com/a...', 'https://x.com/a'],
    ])('leaves the punctuation after %s out of the link', (text, href) => {
      expect(links(text)).toEqual([href]);
    });

    it('drops a closing bracket that has no opener inside the url', () => {
      expect(links('(https://x.com/a)')).toEqual(['https://x.com/a']);
      expect(links('[https://x.com/a]')).toEqual(['https://x.com/a']);
      expect(links('(see https://x.com/a).')).toEqual(['https://x.com/a']);
    });

    it('keeps a balanced pair that belongs to the url', () => {
      expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
      expect(links('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    });

    it('keeps punctuation in the middle of a url', () => {
      expect(links('https://x.com/a.b?c=d,e')).toEqual(['https://x.com/a.b?c=d,e']);
    });

    it('ends a url at a quote or angle bracket around it', () => {
      expect(links('"https://x.com/a" and <https://y.com/b>')).toEqual(['https://x.com/a', 'https://y.com/b']);
    });
  });

  describe('what is never a link', () => {
    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<b>x</b>',
      'ftp://example.com/file',
      'vbscript:msgbox(1)',
      'chrome://settings',
      'www.example.com',
      '/etc/passwd',
    ])('leaves %s as text', text => {
      expect(splitLinks(text)).toEqual([{ kind: 'text', text }]);
    });

    it('does not link a scheme glued onto the end of another word', () => {
      expect(links('xhttps://example.com')).toEqual([]);
    });

    it('does not link a bare scheme with nothing after it', () => {
      expect(links('the https:// prefix, or mailto:.')).toEqual([]);
    });
  });
});
