import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSanitize = vi.hoisted(() => vi.fn((content: string) => content));
vi.mock('dompurify', () => ({ default: { sanitize: mockSanitize } }));

import { sanitizeHtmlForIframe, absolutizeBlessedScripts } from './htmlSanitizer';

describe('sanitizeHtmlForIframe', () => {
  beforeEach(() => {
    mockSanitize.mockReset();
    mockSanitize.mockImplementation((content: string) => content);
  });

  it('passes ADD_TAGS with document shell tags', () => {
    sanitizeHtmlForIframe('<p>hello</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.ADD_TAGS).toEqual(expect.arrayContaining(['link', 'meta', 'style', 'html', 'head', 'body', 'title']));
  });

  it('sets WHOLE_DOCUMENT false for fragment input', () => {
    sanitizeHtmlForIframe('<p>fragment</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.WHOLE_DOCUMENT).toBe(false);
  });

  it('sets WHOLE_DOCUMENT true when input has <!doctype>', () => {
    sanitizeHtmlForIframe('<!DOCTYPE html><html><body></body></html>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.WHOLE_DOCUMENT).toBe(true);
  });

  it('sets WHOLE_DOCUMENT true when input has <html> tag', () => {
    sanitizeHtmlForIframe('<html><body>content</body></html>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.WHOLE_DOCUMENT).toBe(true);
  });

  it('forbids script, iframe, object, embed by default', () => {
    sanitizeHtmlForIframe('<p>hello</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.FORBID_TAGS).toEqual(expect.arrayContaining(['script', 'iframe', 'object', 'embed']));
  });

  it('forbids event-handler attributes', () => {
    sanitizeHtmlForIframe('<p>hello</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.FORBID_ATTR).toEqual(
      expect.arrayContaining(['onload', 'onerror', 'onclick', 'onmouseover', 'onsubmit'])
    );
  });

  it('does NOT include link or meta in FORBID_TAGS', () => {
    sanitizeHtmlForIframe('<p>hello</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.FORBID_TAGS).not.toContain('link');
    expect(config.FORBID_TAGS).not.toContain('meta');
  });

  it('returns isCompleteDocument false for fragment', () => {
    const result = sanitizeHtmlForIframe('<p>text</p>');
    expect(result.isCompleteDocument).toBe(false);
  });

  it('returns isCompleteDocument true for full document', () => {
    const result = sanitizeHtmlForIframe('<!DOCTYPE html><html><body></body></html>');
    expect(result.isCompleteDocument).toBe(true);
  });

  describe('when allowScripts is true', () => {
    it('adds script to ADD_TAGS', () => {
      sanitizeHtmlForIframe('<p>hi</p>', { allowScripts: true });
      const config = mockSanitize.mock.calls[0][1];
      expect(config.ADD_TAGS).toContain('script');
    });

    it('adds src/type/defer/async to ADD_ATTR', () => {
      sanitizeHtmlForIframe('<p>hi</p>', { allowScripts: true });
      const config = mockSanitize.mock.calls[0][1];
      expect(config.ADD_ATTR).toEqual(expect.arrayContaining(['src', 'type', 'defer', 'async']));
    });

    it('does NOT include script in FORBID_TAGS', () => {
      sanitizeHtmlForIframe('<p>hi</p>', { allowScripts: true });
      const config = mockSanitize.mock.calls[0][1];
      expect(config.FORBID_TAGS).not.toContain('script');
    });

    it('still forbids iframe, object, embed even with scripts allowed', () => {
      sanitizeHtmlForIframe('<p>hi</p>', { allowScripts: true });
      const config = mockSanitize.mock.calls[0][1];
      expect(config.FORBID_TAGS).toEqual(expect.arrayContaining(['iframe', 'object', 'embed']));
    });

    it('does NOT narrow ALLOWED_URI_REGEXP (CDN styles/images must survive; CSP is the boundary)', () => {
      sanitizeHtmlForIframe('<p>hi</p>', { allowScripts: true });
      const config = mockSanitize.mock.calls[0][1];
      expect(config.ALLOWED_URI_REGEXP).toBeUndefined();
    });
  });

  it('does not add script to ADD_TAGS when allowScripts is omitted', () => {
    sanitizeHtmlForIframe('<p>hi</p>');
    const config = mockSanitize.mock.calls[0][1];
    expect(config.ADD_TAGS).not.toContain('script');
  });
});

describe('absolutizeBlessedScripts', () => {
  const origin = window.location.origin; // jsdom: http://localhost
  const blessed = '/static/lib/chart.js@4.x.js'; // a BLESSED_SCRIPT_PATHS entry

  it('absolutizes a double-quoted blessed script src to the app origin', () => {
    expect(absolutizeBlessedScripts(`<script src="${blessed}"></script>`)).toBe(
      `<script src="${origin}${blessed}"></script>`
    );
  });

  it('absolutizes a single-quoted blessed script src', () => {
    expect(absolutizeBlessedScripts(`<script src='${blessed}'></script>`)).toBe(
      `<script src='${origin}${blessed}'></script>`
    );
  });

  it('tolerates whitespace around the = in src', () => {
    expect(absolutizeBlessedScripts(`<script  src = "${blessed}"></script>`)).toBe(
      `<script  src = "${origin}${blessed}"></script>`
    );
  });

  it('absolutizes a blessed src even when other attributes precede it', () => {
    expect(absolutizeBlessedScripts(`<script defer src="${blessed}"></script>`)).toBe(
      `<script defer src="${origin}${blessed}"></script>`
    );
  });

  it('leaves NON-blessed /static srcs untouched (exact-match allowlist, mirrors publish path)', () => {
    const html = '<script src="/static/lib/evil.js"></script>';
    expect(absolutizeBlessedScripts(html)).toBe(html);
  });

  it('leaves CDN and other absolute srcs untouched', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>';
    expect(absolutizeBlessedScripts(html)).toBe(html);
  });

  it('does not rewrite a data-src attribute (not a real script source)', () => {
    const html = `<script data-src="${blessed}"></script>`;
    expect(absolutizeBlessedScripts(html)).toBe(html);
  });

  it('leaves inline scripts (no src) untouched', () => {
    const html = `<script>console.log("${blessed}")</script>`;
    expect(absolutizeBlessedScripts(html)).toBe(html);
  });
});
