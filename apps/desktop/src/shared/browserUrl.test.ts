import { describe, expect, it } from 'vitest';
import { normalizeUrl, resolveAddress } from './browserUrl';
import { browserPageModelSchema, browserSnapshotSchema, type BrowserPageModel } from './browserPage';

describe('browserUrl', () => {
  describe('normalizeUrl', () => {
    it('gives a bare host a scheme, https off the machine and http on it', () => {
      expect(normalizeUrl('example.com/cart')).toBe('https://example.com/cart');
      expect(normalizeUrl('localhost:3080')).toBe('http://localhost:3080/');
      expect(normalizeUrl('[::1]:3000')).toBe('http://[::1]:3000/');
    });

    it('leaves a url that already has one alone', () => {
      expect(normalizeUrl('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1');
    });

    // The whole point of routing both the agent and the url bar through here. A file: url in this
    // browser reads the user's disk through a surface the granted-roots checks never see.
    it('refuses every scheme that is not http or https', () => {
      expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/http and https/);
      expect(() => normalizeUrl('b4m-media:12345')).toThrow(/http and https/);
      expect(() => normalizeUrl('b4m-artifact:abc')).toThrow(/http and https/);
      expect(() => normalizeUrl('b4m-artifact://view/00000000-0000-0000-0000-000000000000')).toThrow(/http and https/);
      expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/http and https/);
    });
  });

  describe('resolveAddress', () => {
    it('opens anything that looks like an address', () => {
      expect(resolveAddress('example.com')).toEqual({ ok: true, url: 'https://example.com/' });
      expect(resolveAddress('127.0.0.1:5173/app')).toEqual({ ok: true, url: 'http://127.0.0.1:5173/app' });
      expect(resolveAddress('localhost')).toEqual({ ok: true, url: 'http://localhost/' });
    });

    it('searches for anything that does not', () => {
      expect(resolveAddress('joy slot props')).toEqual({
        ok: true,
        url: 'https://www.google.com/search?q=joy%20slot%20props',
      });
      expect(resolveAddress('slack')).toEqual({ ok: true, url: 'https://www.google.com/search?q=slack' });
    });

    // The ambiguous middle, written down so the rule stays the one people were told: a space
    // searches, a dot goes there, and no list of real TLDs sits behind the dot.
    it('treats any dot as an address, and a space as a search', () => {
      expect(resolveAddress('slack.com')).toEqual({ ok: true, url: 'https://slack.com/' });
      expect(resolveAddress('foo.bar')).toEqual({ ok: true, url: 'https://foo.bar/' });
      expect(resolveAddress('localhost:3000')).toEqual({ ok: true, url: 'http://localhost:3000/' });
      expect(resolveAddress('what is foo.bar')).toEqual({
        ok: true,
        url: 'https://www.google.com/search?q=what%20is%20foo.bar',
      });
    });

    // A refused scheme has to come back as a refusal the user can read. Quietly searching the web
    // for "file:///etc/passwd" would look like the bar simply ignored them.
    it('refuses a written-out scheme rather than searching for it', () => {
      expect(resolveAddress('file:///etc/passwd')).toEqual({
        ok: false,
        error: 'Only http and https pages can be opened, not file:',
      });
      // `b4m-media:1234` parses as a host and a port just as readily as `localhost:3080` does.
      expect(resolveAddress('b4m-media:1234')).toEqual({
        ok: false,
        error: 'Only http and https pages can be opened, not b4m-media:',
      });
    });

    it('says so when nothing was typed', () => {
      expect(resolveAddress('   ')).toMatchObject({ ok: false });
    });
  });
});

describe('browserPage', () => {
  function model(): BrowserPageModel {
    return {
      url: 'https://example.com/article',
      title: 'Article',
      capturedAt: '2026-10-24T12:00:00.000Z',
      blocks: [{ id: 'b1', kind: 'text', text: 'A verified statement.' }],
      actions: [{ ref: '1', kind: 'click', element: 'link', label: 'Source', href: '/source' }],
      claims: [{ id: 'c1', text: 'verified', source: { blockId: 'b1', start: 2, end: 10 } }],
      truncated: false,
    };
  }

  describe('browser page model', () => {
    it('validates a snapshot carrying the typed model beside its outline', () => {
      const page = model();
      expect(
        browserSnapshotSchema.parse({
          url: page.url,
          title: page.title,
          text: 'A verified statement.\n[1] link "Source" -> /source',
          truncated: false,
          model: page,
        }).model
      ).toEqual(page);
    });

    it('rejects duplicate refs and claims that do not match their source spans', () => {
      const page = model();
      page.actions.push({ ref: '1', kind: 'click', element: 'button', label: 'Duplicate' });
      page.claims[0] = { ...page.claims[0], text: 'unattributed' };

      const result = browserPageModelSchema.safeParse(page);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map(issue => issue.message)).toEqual(
          expect.arrayContaining(['Duplicate action ref 1', 'Claim text does not match its source span'])
        );
      }
    });
  });

  describe('claim source integrity', () => {
    it('rejects duplicate block and claim identifiers', () => {
      const page = model();
      page.blocks.push({ id: 'b1', kind: 'text', text: 'Other text' });
      expect(browserPageModelSchema.safeParse(page).success).toBe(false);
      const duplicateClaims = model();
      duplicateClaims.claims.push(duplicateClaims.claims[0]);
      expect(browserPageModelSchema.safeParse(duplicateClaims).success).toBe(false);
    });

    it('rejects spans beyond the source even when slice would clamp them', () => {
      const page = model();
      page.claims[0] = { id: 'c1', text: 'A verified statement.', source: { blockId: 'b1', start: 0, end: 100 } };
      expect(browserPageModelSchema.safeParse(page).success).toBe(false);
    });
  });
});
