// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

const h = vi.hoisted(() => ({
  linkCreate: vi.fn(),
  linkFindOne: vi.fn(),
  linkUpdate: vi.fn(),
  linkDelete: vi.fn(),
  categoryCreate: vi.fn(),
  categoryFindOne: vi.fn(),
  categoryUpdate: vi.fn(),
  categoryDelete: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const on = (method: string) => (fn: (req: unknown, res: unknown) => unknown) => ((routes[method] = fn), chain);
    const chain: Record<string, unknown> = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res),
      { use: () => chain, get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE') }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({ ensureAdmin: () => {} }));
vi.mock('@bike4mind/database/content', () => ({
  ResearchLink: {
    create: h.linkCreate,
    findOne: h.linkFindOne,
    findByIdAndUpdate: h.linkUpdate,
    findByIdAndDelete: h.linkDelete,
  },
  ResearchLinkCategory: {
    create: h.categoryCreate,
    findOne: h.categoryFindOne,
    findByIdAndUpdate: h.categoryUpdate,
    findByIdAndDelete: h.categoryDelete,
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import linksHandler from '../index';
import linkHandler from '../[id]';
import importHandler from '../import';
import categoriesHandler from '../category/index';
import categoryHandler from '../category/[id]';

const LINK_ID = new Types.ObjectId().toString();
const CATEGORY_ID = new Types.ObjectId().toString();

const run = async (
  handler: unknown,
  method: 'POST' | 'PUT' | 'DELETE',
  options: { body?: object; query?: Record<string, string> } = {}
) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('business links admin audit', () => {
  it('POST /business-links records business_link.created', async () => {
    h.linkCreate.mockResolvedValue({ _id: LINK_ID, name: 'Acme', url: 'https://acme.example' });
    const { req, res } = await run(linksHandler, 'POST', { body: { name: 'Acme', url: 'https://acme.example' } });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link.created',
      target: { kind: 'settings', id: LINK_ID, displayName: 'Acme' },
    });
  });

  it('POST /business-links records nothing on a validation 400', async () => {
    const { res } = await run(linksHandler, 'POST', { body: { name: 'no url' } });

    expect(res._getStatusCode()).toBe(400);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('PUT /business-links/[id] records business_link.updated with the changed field names', async () => {
    h.linkUpdate.mockResolvedValue({ id: LINK_ID, name: 'Renamed' });
    await run(linkHandler, 'PUT', { query: { id: LINK_ID }, body: { name: 'Renamed' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link.updated',
      target: { kind: 'settings', id: LINK_ID, displayName: 'Renamed' },
      details: { fields: ['name'] },
    });
  });

  it('PUT /business-links/[id] records nothing when the link is missing', async () => {
    h.linkUpdate.mockResolvedValue(null);
    const { res } = await run(linkHandler, 'PUT', { query: { id: LINK_ID }, body: { name: 'x' } });

    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('DELETE /business-links/[id] records business_link.deleted', async () => {
    h.linkDelete.mockResolvedValue({ name: 'Acme', url: 'https://acme.example' });
    await run(linkHandler, 'DELETE', { query: { id: LINK_ID } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link.deleted',
      target: { kind: 'settings', id: LINK_ID, displayName: 'Acme' },
    });
  });

  it('POST /business-links/import records one imported entry with the counts', async () => {
    h.categoryFindOne.mockResolvedValue({ _id: CATEGORY_ID });
    h.linkFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: LINK_ID });
    h.linkCreate.mockResolvedValue({});
    h.linkUpdate.mockResolvedValue({});
    const csv = [
      'name,ticker,url,type,category,description',
      'Acme,ACM,https://acme.example,stock,News,desc',
      'Beta,BET,https://beta.example,stock,News,desc',
      ',,,,,',
    ].join('\n');
    const { res } = await run(importHandler, 'POST', { body: { csv } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link.imported',
      target: { kind: 'system', id: 'business-links-import' },
      details: { created: 1, updated: 1, errors: 1, total: 3 },
    });
  });

  it('POST /business-links/category records business_link_category.created', async () => {
    h.categoryCreate.mockResolvedValue({ _id: CATEGORY_ID, name: 'News' });
    await run(categoriesHandler, 'POST', { body: { name: 'News', description: 'Headlines' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link_category.created',
      target: { kind: 'settings', id: CATEGORY_ID, displayName: 'News' },
    });
  });

  it('PUT /business-links/category/[id] records business_link_category.updated', async () => {
    h.categoryUpdate.mockResolvedValue({ name: 'World news' });
    await run(categoryHandler, 'PUT', { query: { id: CATEGORY_ID }, body: { name: 'World news' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link_category.updated',
      target: { kind: 'settings', id: CATEGORY_ID, displayName: 'World news' },
      details: { fields: ['name'] },
    });
  });

  it('DELETE /business-links/category/[id] records business_link_category.deleted', async () => {
    h.categoryDelete.mockResolvedValue({ name: 'News' });
    await run(categoryHandler, 'DELETE', { query: { id: CATEGORY_ID } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.business_link_category.deleted',
      target: { kind: 'settings', id: CATEGORY_ID, displayName: 'News' },
    });
  });

  it('DELETE /business-links/category/[id] records nothing when the category is missing', async () => {
    h.categoryDelete.mockResolvedValue(null);
    const { res } = await run(categoryHandler, 'DELETE', { query: { id: CATEGORY_ID } });

    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
