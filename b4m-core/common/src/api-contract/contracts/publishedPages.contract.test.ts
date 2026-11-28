import { describe, expect, it } from 'vitest';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import * as c from './publishedPages.contract';
import {
  CreatedPublishedPageShareLinkSchema,
  ListPublishedPageShareLinksResponseSchema,
  PublishedPageShareLinkSchema,
} from '../../schemas/publishedPagePublic';

const contracts = Object.values(c);

describe('published pages contracts', () => {
  it('declares 15 operations under /api/v1/published-pages, each needing artifacts:publish', () => {
    expect(contracts).toHaveLength(15);
    for (const contract of contracts) {
      expect(contract.path.startsWith('/api/v1/published-pages')).toBe(true);
      expect(contract.scopes).toEqual([ApiKeyScope.ARTIFACTS_PUBLISH]);
    }
    expect(new Set(contracts.map(x => x.operationId)).size).toBe(15);
  });

  it('maps the share-link and download operations to the expected method and path', () => {
    expect([c.listPublishedPageShareLinksContract.method, c.listPublishedPageShareLinksContract.path]).toEqual([
      'get',
      '/api/v1/published-pages/{public_id}/share-links',
    ]);
    expect([c.revokePublishedPageShareLinkContract.method, c.revokePublishedPageShareLinkContract.path]).toEqual([
      'delete',
      '/api/v1/published-pages/{public_id}/share-links/{link_id}',
    ]);
    expect(c.downloadPublishedPageFileContract.responses[303]).toBeDefined();
  });

  it('never returns a token or URL in the share-link list', () => {
    expect(Object.keys(PublishedPageShareLinkSchema.shape)).not.toContain('token');
    expect(Object.keys(PublishedPageShareLinkSchema.shape)).not.toContain('share_url');
    const parsed = ListPublishedPageShareLinksResponseSchema.parse({
      data: [
        {
          id: 'l1',
          token_hint: 'abcd',
          created_at: null,
          expires_at: null,
          view_count: 0,
          last_viewed_at: null,
          token: 'secret-token',
          share_url: 'https://example.com/a/secret-token',
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(parsed)).not.toContain('secret-token');
  });

  it('requires share_url on the create response', () => {
    expect(CreatedPublishedPageShareLinkSchema.safeParse({ id: 'l1', expires_at: null }).success).toBe(false);
  });
});
