/**
 * Characterization + type-contract tests for the Confluence response formatters.
 * Locks behavior across the any -> Raw* typing refactor. formatSearchResults keeps
 * a tolerant, loosely-typed input, so a loosely-shaped (e.g. Jira-like) payload is exercised here too.
 */
import { describe, it, expect } from 'vitest';
import {
  formatUserResponse,
  formatPageResponse,
  formatSearchResults,
  formatSpaceResponse,
  formatSpaceList,
  formatCommentResponse,
  formatCommentList,
  formatPageList,
  formatPageRestrictions,
} from '../format';

const SITE = 'https://example.atlassian.net/wiki';

describe('formatUserResponse', () => {
  it('maps only the known user fields', () => {
    expect(formatUserResponse({ type: 'known', accountId: 'a1', displayName: 'Jane', extra: 'drop' } as any)).toEqual({
      type: 'known',
      accountId: 'a1',
      accountType: undefined,
      email: undefined,
      publicName: undefined,
      displayName: 'Jane',
      personalSpace: undefined,
    });
  });

  it('throws on an error-envelope payload', () => {
    // Aligns with sibling formatters: throws instead of returning the raw error object.
    expect(() => formatUserResponse({ errors: [{ status: 404 }] } as any)).toThrow(/malformed/);
  });
});

describe('formatPageResponse', () => {
  it('formats a page and builds a webui link, stripping HTML', () => {
    const page = {
      id: '123',
      title: 'Hello',
      status: 'current',
      spaceId: 'S1',
      parentId: 'P1',
      space: { key: 'DEV' },
      body: { storage: { value: '<p>Hi &amp; bye</p>' } },
      version: { number: 3 },
      _links: { base: SITE, webui: '/pages/123' },
    };
    expect(formatPageResponse(page as any, SITE)).toEqual({
      pageId: '123',
      title: 'Hello',
      status: 'current',
      spaceId: 'S1',
      spaceKey: 'DEV',
      body: 'Hi & bye',
      version: 3,
      parentId: 'P1',
      link: `${SITE}/pages/123`,
    });
  });

  it('throws on a payload with no id', () => {
    expect(() => formatPageResponse({ title: 'x' } as any, SITE)).toThrow(/malformed/);
  });
});

describe('formatSearchResults', () => {
  it('formats Confluence-shaped results', () => {
    const raw = {
      results: [
        { content: { id: 'c1', title: 'T' }, url: '/display/x', body: { view: { value: '<b>hi</b>' } }, excerpt: 'ex' },
      ],
      totalSize: 1,
      start: 0,
      limit: 25,
      _links: { base: SITE },
    };
    const out = formatSearchResults(raw as any, SITE);
    expect(out.total).toBe(1);
    expect(out.results[0]).toEqual({
      id: 'c1',
      title: 'T',
      url: `${SITE}/display/x`,
      space: { id: undefined, key: undefined, name: undefined },
      body: 'hi',
      excerpt: 'ex',
      lastModified: undefined,
    });
  });

  it('accepts a loosely-shaped (Jira-like) result without error', () => {
    const jiraLike = { results: [{ id: 'J-1', title: 'Bug', url: '/browse/J-1' }], total: 1, start: 0, limit: 50 };
    const out = formatSearchResults(jiraLike as any, SITE);
    expect(out.results[0].id).toBe('J-1');
  });

  it('throws on a malformed/error payload', () => {
    expect(() => formatSearchResults({ errors: [{ status: 400 }] } as any, SITE)).toThrow(/malformed/);
  });

  it('returns a guidance message on zero results', () => {
    const out = formatSearchResults({ results: [], size: 0, start: 0, limit: 25 } as any, SITE);
    expect(out.results).toHaveLength(0);
    expect(out.message).toMatch(/No results found/);
  });
});

describe('formatSpaceResponse / formatSpaceList', () => {
  it('formats a space and builds a webui link', () => {
    const space = {
      id: 'S1',
      key: 'DEV',
      name: 'Dev',
      type: 'global',
      description: { plain: { value: 'desc' } },
      _links: { base: SITE, webui: '/spaces/DEV' },
    };
    expect(formatSpaceResponse(space as any, SITE)).toEqual({
      id: 'S1',
      key: 'DEV',
      name: 'Dev',
      description: 'desc',
      type: 'global',
      link: `${SITE}/spaces/DEV`,
    });
  });

  it('coerces a numeric v1 space id to a string', () => {
    const space = { id: 11, key: 'DEV', name: 'Dev', description: { value: '' }, _links: { base: SITE } };
    expect(formatSpaceResponse(space as any, SITE).id).toBe('11');
  });

  it('formats a space list', () => {
    const list = { results: [{ key: 'DEV', name: 'Dev', description: { value: '' }, _links: { base: SITE } }] };
    expect(formatSpaceList(list as any, SITE).results).toHaveLength(1);
  });
});

describe('formatCommentResponse / formatCommentList', () => {
  it('formats a comment with author + parent linkage', () => {
    const comment = {
      id: 'c1',
      type: 'comment',
      status: 'current',
      title: 'Re: Page',
      body: { storage: { value: '<p>reply</p>' } },
      history: {
        createdBy: { accountId: 'a1', displayName: 'Jane' },
        createdDate: '2026-01-01',
        lastUpdated: { when: '2026-01-02' },
      },
      container: { id: 'P1' },
      ancestors: [{ id: 'anc1' }],
      extensions: { inlineProperties: { ref: 'x' } },
      _links: { base: SITE, webui: '/c/1' },
    };
    const out = formatCommentResponse(comment as any, SITE);
    expect(out.id).toBe('c1');
    expect(out.body).toBe('reply');
    expect(out.author?.accountId).toBe('a1');
    expect(out.parentId).toBe('P1');
    expect(out.parentCommentId).toBe('anc1');
    expect(out.link).toBe(`${SITE}/c/1`);
  });

  it('formats a comment list with paging fields', () => {
    const list = {
      results: [{ id: 'c1', body: { view: { value: 'x' } }, _links: { base: SITE } }],
      start: 0,
      limit: 25,
      size: 1,
    };
    const out = formatCommentList(list as any, SITE);
    expect(out.results).toHaveLength(1);
    expect(out.size).toBe(1);
  });
});

describe('formatPageList', () => {
  it('maps list items to the trimmed shape', () => {
    const list = { results: [{ id: '1', title: 'A', status: 'current', parentId: 'P', spaceId: 'S' }] };
    expect(formatPageList(list as any, SITE).results[0]).toEqual({
      pageId: '1',
      title: 'A',
      status: 'current',
      parentId: 'P',
      spaceId: 'S',
    });
  });
});

describe('formatPageRestrictions', () => {
  it('parses the array format', () => {
    const raw = {
      results: [
        {
          operation: 'read',
          restrictions: { user: { results: [{ accountId: 'u1', displayName: 'U1' }] }, group: { results: [] } },
        },
        { operation: 'update', restrictions: { user: { results: [] }, group: { results: [{ name: 'admins' }] } } },
      ],
    };
    const out = formatPageRestrictions(raw as any, 'PG1');
    expect(out.pageId).toBe('PG1');
    expect(out.hasRestrictions).toBe(true);
    expect(out.restrictions.find(r => r.operation === 'read')?.subjects[0]).toEqual({
      type: 'user',
      identifier: 'u1',
      displayName: 'U1',
    });
    expect(out.restrictions.find(r => r.operation === 'update')?.subjects[0]).toEqual({
      type: 'group',
      identifier: 'admins',
      displayName: 'admins',
    });
  });

  it('parses the object format (direct read/update keys)', () => {
    const raw = {
      read: { restrictions: { user: { results: [{ accountId: 'u1', displayName: 'U1' }] } } },
      update: { restrictions: { group: { results: [{ name: 'admins' }] } } },
    };
    const out = formatPageRestrictions(raw as any, 'PG1');
    expect(out.hasRestrictions).toBe(true);
    expect(out.restrictions.find(r => r.operation === 'read')?.subjects[0]).toEqual({
      type: 'user',
      identifier: 'u1',
      displayName: 'U1',
    });
    expect(out.restrictions.find(r => r.operation === 'update')?.subjects[0]).toEqual({
      type: 'group',
      identifier: 'admins',
      displayName: 'admins',
    });
  });

  it('extracts subjects when user/group are bare arrays (no results wrapper)', () => {
    const raw = {
      results: [
        {
          operation: 'read',
          restrictions: { user: [{ accountId: 'u1', displayName: 'U1' }], group: [{ name: 'admins' }] },
        },
      ],
    };
    const out = formatPageRestrictions(raw as any, 'PG1');
    const read = out.restrictions.find(r => r.operation === 'read');
    expect(read?.subjects).toContainEqual({ type: 'user', identifier: 'u1', displayName: 'U1' });
    expect(read?.subjects).toContainEqual({ type: 'group', identifier: 'admins', displayName: 'admins' });
  });

  it('returns empty restrictions on an error payload', () => {
    const out = formatPageRestrictions({ error: 'nope' } as any, 'PG1');
    expect(out).toEqual({ pageId: 'PG1', hasRestrictions: false, restrictions: [] });
  });

  it('returns empty restrictions on a plural-errors envelope', () => {
    const out = formatPageRestrictions({ errors: [{ status: 500 }] } as any, 'PG1');
    expect(out).toEqual({ pageId: 'PG1', hasRestrictions: false, restrictions: [] });
  });
});
