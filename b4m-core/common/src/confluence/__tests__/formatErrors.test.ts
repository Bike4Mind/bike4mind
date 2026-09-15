/**
 * Confluence formatter error-path - Unit Tests
 *
 * Locks in the throw-on-malformed-2xx-body contract introduced when the formatters
 * moved from `return payload` (which silently passed error envelopes through to the
 * AI as a "successful" result) to `throw confluenceResponseError(...)`. The request
 * layer already throws on non-2xx; these guard the rare 2xx-with-bad-body case, and
 * every MCP tool wraps these calls in try/catch so the throw surfaces cleanly.
 *
 * Without these tests a future "helpful" refactor could revert the throws to
 * passing junk through, and nothing else in the suite would catch it.
 */

import { describe, it, expect } from 'vitest';
import {
  formatPageResponse,
  formatSearchResults,
  formatSpaceResponse,
  formatSpaceList,
  formatCommentResponse,
  formatCommentList,
  formatPageList,
} from '../format';

const SITE_URL = 'https://example.atlassian.net/wiki';

// (formatter, label, a minimal body that should format cleanly)
const formatters: Array<[(payload: any, ctx: string) => unknown, string, unknown]> = [
  [formatPageResponse, 'page', { id: '123', title: 'Hello' }],
  [formatSearchResults, 'search', { results: [] }],
  [formatSpaceResponse, 'space', { id: 'S1', key: 'KEY', name: 'Space' }],
  [formatSpaceList, 'space list', { results: [] }],
  [formatCommentResponse, 'comment', { id: 'C1' }],
  [formatCommentList, 'comment list', { results: [] }],
  [formatPageList, 'page list', { results: [] }],
];

describe('Confluence formatter error paths', () => {
  describe.each(formatters)('%o (%s)', (format, _label, validBody) => {
    it('throws on an error envelope ({ error })', () => {
      expect(() => format({ error: 'boom' }, SITE_URL)).toThrow(/malformed/i);
    });

    it('throws on a validation envelope ({ errors })', () => {
      expect(() => format({ errors: [{ message: 'bad request' }] }, SITE_URL)).toThrow(/malformed/i);
    });

    it('throws on null', () => {
      expect(() => format(null, SITE_URL)).toThrow(/malformed/i);
    });

    it('throws on a non-object body', () => {
      expect(() => format('<html>gateway timeout</html>', SITE_URL)).toThrow(/malformed/i);
    });

    it('does not throw on a minimally valid body', () => {
      expect(() => format(validBody, SITE_URL)).not.toThrow();
    });
  });

  // formatPageResponse additionally requires an `id` (it builds a page link from it).
  it('formatPageResponse throws when `id` is missing', () => {
    expect(() => formatPageResponse({ title: 'no id here' }, SITE_URL)).toThrow(/page response was malformed/i);
  });

  it('surfaces the error detail from the envelope in the thrown message', () => {
    expect(() => formatPageResponse({ error: 'Page not found' }, SITE_URL)).toThrow('Page not found');
  });
});
