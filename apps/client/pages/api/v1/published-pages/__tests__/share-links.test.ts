// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreatedPublishedPageShareLinkSchema,
  ListPublishedPageShareLinksResponseSchema,
  PublishedPageShareLinkParamSchema,
} from '@bike4mind/common';
import { ZodError } from 'zod';
import { callRoute } from './routeMocks';

const store = vi.hoisted(() => ({ links: [] as Array<{ id: string; token: string; expiresAt: Date | null }> }));

vi.mock('@server/middlewares/defineNextRoute', async () => ({
  nextRouteForContract: (await import('./routeMocks')).nextRouteForContractMock(),
}));
vi.mock('@server/middlewares/dispatchByMethod', async () => ({
  dispatchByMethod: (await import('./routeMocks')).dispatchByMethodMock(),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ assertOutboundActionAllowed: vi.fn() }));
vi.mock('@server/services/publish/managePublishedPages', async orig => {
  const { HTTPError } = await import('@bike4mind/server-utils/utils/errors');
  return {
    ...(await orig<Record<string, unknown>>()),
    getPublishedPage: async ({ publicId }: { publicId: string }) => {
      if (publicId === 'missing') throw new HTTPError(404, 'Artifact not found', { errorCode: 'not_found' });
      if (publicId === 'private-other')
        throw new HTTPError(403, 'Published page not found', { errorCode: 'forbidden' });
      return { artifact: {}, isManager: publicId !== 'public-other' };
    },
  };
});
vi.mock('@server/services/publish/shareLinks', async orig => {
  const actual = await orig<typeof import('@server/services/publish/shareLinks')>();
  const { PublishServiceError } = await import('@server/services/publish/publishServiceError');
  const view = (l: (typeof store.links)[number]) => ({
    id: l.id,
    shareToken: l.token,
    shareUrl: `/a/${l.token}`,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: l.expiresAt,
    viewCount: 2,
    lastViewedAt: null,
  });
  return {
    ...actual,
    listShareLinks: async () => store.links.map(view),
    createShareLink: async (input: { expiresAt?: unknown; additional?: boolean }) => {
      if (input.expiresAt === '2030-01-01T00:00:00Z') throw new PublishServiceError(400, 'bad expiry');
      const link = {
        id: String(store.links.length).padStart(24, '0'),
        token: `tok-${'x'.repeat(40)}-${store.links.length}abcd`,
        expiresAt: null,
      };
      store.links.push(link);
      return { ...view(link), shareLinks: store.links.map(view) };
    },
    revokeShareLink: async (input: { id?: string; publicId: string }) => {
      if (input.publicId === 'gated') {
        throw new PublishServiceError(400, 'orphan', { errorCode: actual.SHARE_LINK_ERROR_CODES.wouldOrphanGate });
      }
      const index = store.links.findIndex(l => l.id === input.id);
      if (index < 0) throw new PublishServiceError(404, 'No live share link with that id');
      store.links.splice(index, 1);
      return { revoked: true, remaining: store.links.length };
    },
  };
});

import shareLinks from '../[public_id]/share-links/index';
import revoke from '../[public_id]/share-links/[link_id]';

const ABSENT_LINK = 'f'.repeat(24);
const BAD = '2030-01-01T00:00:00Z';
const PAGE = { public_id: 'k3x9d2' };

describe('/api/v1/published-pages/{public_id}/share-links', () => {
  beforeEach(() => {
    store.links.length = 0;
    process.env.APP_URL = 'https://app.example.com';
  });

  it('returns the full URL once on create, and a list that never repeats the token', async () => {
    const created = await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('private, no-store');
    const body = CreatedPublishedPageShareLinkSchema.parse(created.json);
    const token = store.links[0].token;
    expect(body.share_url).toBe(`https://app.example.com/a/${token}`);

    const listed = await callRoute(shareLinks, { method: 'GET', query: PAGE });
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('private, no-store');
    const list = ListPublishedPageShareLinksResponseSchema.parse(listed.json);
    expect(list.next_cursor).toBeNull();
    expect(list.data).toEqual([
      {
        id: body.id,
        token_hint: token.slice(-4),
        created_at: '2026-10-01T00:00:00.000Z',
        expires_at: null,
        view_count: 2,
        last_viewed_at: null,
      },
    ]);
    expect(listed.text).not.toContain(token);
    expect(listed.text).not.toContain('/a/');
    expect(Object.keys(listed.json!.data[0]).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'last_viewed_at',
      'token_hint',
      'view_count',
    ]);
  });

  it('strips a token from every link the service returns', async () => {
    store.links.push(
      { id: 'a', token: 'secret-token-aaaa', expiresAt: null },
      { id: 'b', token: 'secret-token-bbbb', expiresAt: null }
    );
    const listed = await callRoute(shareLinks, { method: 'GET', query: PAGE });
    expect(listed.text).not.toContain('secret-token');
    expect(listed.json!.data.map(l => l.token_hint)).toEqual(['aaaa', 'bbbb']);
  });

  it('revokes by link_id and the link leaves the list', async () => {
    await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    const [first] = store.links;
    const res = await callRoute(revoke, { method: 'DELETE', query: { ...PAGE, link_id: first.id } });
    expect(res.status).toBe(204);
    const listed = await callRoute(shareLinks, { method: 'GET', query: PAGE });
    expect(listed.json!.data).toHaveLength(1);
  });

  it('answers only declared statuses for service refusals', async () => {
    expect((await callRoute(revoke, { method: 'DELETE', query: { ...PAGE, link_id: ABSENT_LINK } })).status).toBe(404);
    expect(
      (await callRoute(revoke, { method: 'DELETE', query: { public_id: 'gated', link_id: ABSENT_LINK } })).status
    ).toBe(409);
    expect((await callRoute(shareLinks, { method: 'POST', query: PAGE, body: { expires_at: BAD } })).status).toBe(422);
  });

  it("rejects a cursor minted for another page's link list", async () => {
    for (let i = 0; i < 2; i++) await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    const first = await callRoute(shareLinks, { method: 'GET', query: { ...PAGE, limit: '1' } });
    const cursor = (first.json as unknown as { next_cursor: string }).next_cursor;
    expect(cursor).toEqual(expect.any(String));
    expect((await callRoute(shareLinks, { method: 'GET', query: { ...PAGE, limit: '1', cursor } })).status).toBe(200);
    const other = await callRoute(shareLinks, {
      method: 'GET',
      query: { public_id: 'other-page', limit: '1', cursor },
    });
    expect(other.status).toBe(422);
  });

  it('never revokes every link for a blank or malformed link_id', async () => {
    await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    await callRoute(shareLinks, { method: 'POST', query: PAGE, body: {} });
    for (const link_id of [' ', '\t', 'nope']) {
      expect(PublishedPageShareLinkParamSchema.safeParse({ ...PAGE, link_id }).success).toBe(false);
      await expect(callRoute(revoke, { method: 'DELETE', query: { ...PAGE, link_id } })).rejects.toBeInstanceOf(
        ZodError
      );
    }
    expect(store.links).toHaveLength(2);
  });

  it("answers one identical 404 body for a missing page and another user's private or public page", async () => {
    const bodies = [];
    for (const public_id of ['missing', 'private-other', 'public-other']) {
      const res = await callRoute(shareLinks, { method: 'GET', query: { public_id } });
      expect(res.status).toBe(404);
      bodies.push(res.text);
      const revoked = await callRoute(revoke, { method: 'DELETE', query: { public_id, link_id: ABSENT_LINK } });
      expect(revoked.status).toBe(404);
      bodies.push(revoked.text);
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('pages the list by limit and cursor, and rejects a malformed cursor', async () => {
    store.links.push(
      { id: 'a'.repeat(24), token: 'tok-aaaa', expiresAt: null },
      { id: 'b'.repeat(24), token: 'tok-bbbb', expiresAt: null },
      { id: 'c'.repeat(24), token: 'tok-cccc', expiresAt: null }
    );
    const first = await callRoute(shareLinks, { method: 'GET', query: { ...PAGE, limit: '2' } });
    expect(first.json!.data).toHaveLength(2);
    const { next_cursor } = first.json as unknown as { next_cursor: string };
    expect(next_cursor).toEqual(expect.any(String));
    const second = await callRoute(shareLinks, { method: 'GET', query: { ...PAGE, limit: '2', cursor: next_cursor } });
    expect(second.json!.data).toHaveLength(1);
    await expect(
      callRoute(shareLinks, { method: 'GET', query: { ...PAGE, cursor: 'garbage' } })
    ).resolves.toMatchObject({
      status: 422,
    });
  });
});
