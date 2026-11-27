// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublishedPageCommentSchema,
  ListPublishedPageCommentsResponseSchema,
  PublishedPageResourceSchema,
} from '@bike4mind/common';
import { callRoute } from './routeMocks';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  download: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', async () => ({
  nextRouteForContract: (await import('./routeMocks')).nextRouteForContractMock(),
}));
vi.mock('@server/middlewares/dispatchByMethod', async () => ({
  dispatchByMethod: (await import('./routeMocks')).dispatchByMethodMock(),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ assertOutboundActionAllowed: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getPublishedArtifactsStorage: () => ({}) }));
vi.mock('@server/services/publish/managePublishedPages', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const { NotFoundError } = await import('@bike4mind/server-utils/utils/errors');
  const page = {
    publicId: 'k3x9d2',
    ownerId: 'user-1',
    tier: 'user',
    scopeId: 'user-1',
    slug: 'q3-report',
    title: 'Q3 report',
    visibility: 'private',
    commentPolicy: 'open',
    storageKeyPrefix: 'pages/k3x9d2/',
    manifest: [{ path: 'index.html' }, { path: 'assets/app.js' }],
    size: { totalBytes: 100, fileCount: 2 },
    publishedAt: new Date('2026-10-01T00:00:00Z'),
  };
  return {
    ...actual,
    getPublishedPage: async ({ publicId }: { publicId: string }) => {
      if (publicId === 'k3x9d2') return { artifact: page, isManager: true };
      if (publicId === 'public-other') return { artifact: { ...page, ownerId: 'someone' }, isManager: false };
      throw new NotFoundError('Artifact not found', { errorCode: 'not_found' });
    },
  };
});
vi.mock('@server/services/publish/restorePublishedVersion', () => ({ restorePublishedVersion: mocks.restore }));
vi.mock('@server/services/publish/annotations', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  listAnnotations: mocks.list,
  createAnnotation: mocks.create,
  updateAnnotation: mocks.update,
  deleteAnnotation: mocks.remove,
}));
vi.mock('@server/services/publish/resolveBundleDownload', () => ({ resolveBundleDownload: mocks.download }));

import restore from '../[public_id]/restore';
import comments from '../[public_id]/comments/index';
import comment from '../[public_id]/comments/[comment_id]';
import download from '../[public_id]/files/download';
import { ForbiddenError, HTTPError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const PAGE = { public_id: 'k3x9d2' };
const dto = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  publicId: 'k3x9d2',
  kind: 'comment',
  authorDisplayName: 'Ada',
  body: 'Looks right.',
  threadRootId: null,
  resolvedAt: null,
  createdAt: '2026-10-02T09:30:00.000Z',
  ...over,
});

describe('published page sub-routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.APP_URL = 'https://app.example.com';
  });

  describe('restore', () => {
    it('restores and returns the page resource', async () => {
      mocks.restore.mockResolvedValue({});
      const res = await callRoute(restore, { method: 'POST', query: PAGE, body: { sha: 'abc' } });
      expect(res.status).toBe(200);
      expect(PublishedPageResourceSchema.parse(res.json).public_id).toBe('k3x9d2');
      expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'k3x9d2', sha: 'abc' }));
    });

    it('404s a page the caller does not manage, without restoring', async () => {
      for (const id of ['missing', 'public-other']) {
        const res = await callRoute(restore, { method: 'POST', query: { public_id: id }, body: {} });
        expect(res.status).toBe(404);
      }
      expect(mocks.restore).not.toHaveBeenCalled();
    });

    it('reports an archive quota overflow (413) as 422', async () => {
      mocks.restore.mockRejectedValue(new HTTPError(413, 'Archived versions would exceed the quota'));
      const res = await callRoute(restore, { method: 'POST', query: PAGE, body: {} });
      expect(res.status).toBe(422);
    });

    it('reports a missing previous version as 422', async () => {
      mocks.restore.mockRejectedValue(new HTTPError(400, 'No previous version to restore'));
      const res = await callRoute(restore, { method: 'POST', query: PAGE, body: {} });
      expect(res.status).toBe(422);
      expect(res.json!.error).toBe('No previous version to restore');
    });
  });

  describe('comments', () => {
    it('lists snake_case comments with null for absent fields', async () => {
      mocks.list.mockResolvedValue({
        annotations: [
          dto({ anchor: { x: 0.5, scrollSection: 'intro' }, artifactVersionSha: 'sha1' }),
          dto({ id: 'c2' }),
        ],
        hasMore: false,
      });
      const res = await callRoute(comments, { method: 'GET', query: PAGE });
      expect(res.status).toBe(200);
      const body = ListPublishedPageCommentsResponseSchema.parse(res.json);
      expect(body.next_cursor).toBeNull();
      expect(body.data[0]).toMatchObject({ anchor: { x: 0.5, scroll_section: 'intro' }, artifact_version_sha: 'sha1' });
      expect(body.data[1]).toMatchObject({ anchor: null, artifact_version_sha: null, thread_root_id: null });
    });

    it('pages the list by limit, hands out a cursor and rejects a malformed one', async () => {
      mocks.list.mockResolvedValue({
        annotations: [
          dto({ id: '5b1f6a0e00000000000000a0', createdAt: '2026-10-01T09:30:00.000Z' }),
          dto({ id: '5b1f6a0e00000000000000a1' }),
        ],
        hasMore: true,
      });
      const first = await callRoute(comments, { method: 'GET', query: { ...PAGE, limit: '1' } });
      expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ page: { limit: 1, after: undefined } }));
      const cursor = (first.json as unknown as { next_cursor: string }).next_cursor;
      expect(cursor).toEqual(expect.any(String));

      mocks.list.mockResolvedValue({ annotations: [], hasMore: false });
      await callRoute(comments, { method: 'GET', query: { ...PAGE, limit: '1', cursor } });
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: { limit: 1, after: { at: new Date('2026-10-02T09:30:00.000Z'), id: '5b1f6a0e00000000000000a1' } },
        })
      );
      // A cursor minted for this page is not valid on another.
      mocks.list.mockClear();
      const other = await callRoute(comments, {
        method: 'GET',
        query: { public_id: 'other-page', limit: '1', cursor },
      });
      expect(other.status).toBe(422);
      expect(mocks.list).not.toHaveBeenCalled();
      const bad = await callRoute(comments, { method: 'GET', query: { ...PAGE, cursor: 'garbage' } });
      expect(bad.status).toBe(422);
      expect(mocks.list).not.toHaveBeenCalled();
    });

    it('creates a comment (201) mapping the anchor to the service shape', async () => {
      mocks.create.mockResolvedValue(dto());
      const res = await callRoute(comments, {
        method: 'POST',
        query: PAGE,
        body: { body: 'Looks right.', anchor: { scroll_section: 'intro' }, thread_root_id: 't1' },
      });
      expect(res.status).toBe(201);
      PublishedPageCommentSchema.parse(res.json);
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { body: 'Looks right.', anchor: { scrollSection: 'intro' }, threadRootId: 't1' },
        })
      );
    });

    it('remaps a disabled comment policy and a bad thread root to 422', async () => {
      mocks.create.mockRejectedValueOnce(
        new ForbiddenError('Commenting is disabled', { errorCode: 'comments_disabled' })
      );
      expect((await callRoute(comments, { method: 'POST', query: PAGE, body: { body: 'x' } })).status).toBe(422);
      mocks.create.mockRejectedValueOnce(new HTTPError(400, 'bad root', { errorCode: 'invalid_thread_root' }));
      expect((await callRoute(comments, { method: 'POST', query: PAGE, body: { body: 'x' } })).status).toBe(422);
    });

    it('404s list and create on a page the caller does not manage', async () => {
      const query = { public_id: 'public-other' };
      expect((await callRoute(comments, { method: 'GET', query })).status).toBe(404);
      expect((await callRoute(comments, { method: 'POST', query, body: { body: 'x' } })).status).toBe(404);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it('updates (200) and deletes (204) a comment', async () => {
      mocks.update.mockResolvedValue(dto({ resolvedAt: '2026-10-03T00:00:00.000Z' }));
      const patched = await callRoute(comment, {
        method: 'PATCH',
        query: { ...PAGE, comment_id: 'c1' },
        body: { resolved: true },
      });
      expect(patched.status).toBe(200);
      expect(PublishedPageCommentSchema.parse(patched.json).resolved_at).toBe('2026-10-03T00:00:00.000Z');
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', input: { resolved: true } }));

      const deleted = await callRoute(comment, { method: 'DELETE', query: { ...PAGE, comment_id: 'c1' } });
      expect(deleted.status).toBe(204);
    });

    it('answers a non-author body edit with a 403 whose errorCode is not on the wire', async () => {
      mocks.update.mockRejectedValue(
        new ForbiddenError('Only the author may edit this annotation', { errorCode: 'author_only' })
      );
      const res = await callRoute(comment, {
        method: 'PATCH',
        query: { ...PAGE, comment_id: 'c1' },
        body: { body: 'x' },
      });
      expect(res.status).toBe(403);
      expect(res.json).toEqual(expect.objectContaining({ error: 'Only the author may edit this annotation' }));
      expect(res.json).not.toHaveProperty('errorCode');
    });

    it('404s an unknown comment and an unmanaged page', async () => {
      mocks.remove.mockRejectedValue(new NotFoundError('Not found', { errorCode: 'not_found' }));
      expect((await callRoute(comment, { method: 'DELETE', query: { ...PAGE, comment_id: 'nope' } })).status).toBe(404);
      const res = await callRoute(comment, {
        method: 'PATCH',
        query: { public_id: 'missing', comment_id: 'c1' },
        body: { resolved: true },
      });
      expect(res.status).toBe(404);
      expect(mocks.update).not.toHaveBeenCalled();
    });
  });

  describe('download', () => {
    it('answers 303 with the signed Location, no body, private no-store', async () => {
      mocks.download.mockResolvedValue({
        key: 'k',
        disposition: 'attachment',
        url: 'https://storage.example.com/signed?x=1',
      });
      const res = await callRoute(download, { method: 'GET', query: { ...PAGE, path: 'assets/app.js' } });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('https://storage.example.com/signed?x=1');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.text).toBe('');
      expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ assetPath: 'assets/app.js' }));
    });

    it('404s a file outside the manifest and a page the caller does not manage', async () => {
      mocks.download.mockRejectedValue(
        new NotFoundError('Asset not in artifact manifest', { errorCode: 'asset_not_found' })
      );
      expect((await callRoute(download, { method: 'GET', query: { ...PAGE, path: 'nope.txt' } })).status).toBe(404);
      mocks.download.mockClear();
      const res = await callRoute(download, {
        method: 'GET',
        query: { public_id: 'public-other', path: 'index.html' },
      });
      expect(res.status).toBe(404);
      expect(mocks.download).not.toHaveBeenCalled();
    });
  });
});
