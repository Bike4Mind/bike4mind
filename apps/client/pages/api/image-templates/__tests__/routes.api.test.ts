import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError, ForbiddenError, UnprocessableEntityError } from '@bike4mind/common';

const { list, get, save, update, del, recordUse } = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  recordUse: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the
// handler. A thrown HTTPError is mapped to res.status(err.statusCode) - mirroring the real
// errorHandler - since these routes delegate 403/404/422 to service throws rather than
// returning statuses inline.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        try {
          return await h[(req as { method?: string }).method ?? 'GET']?.(req, res);
        } catch (err) {
          const status =
            typeof (err as { statusCode?: number })?.statusCode === 'number'
              ? (err as { statusCode: number }).statusCode
              : 500;
          (res as { status: (n: number) => { json: (b: unknown) => void } })
            .status(status)
            .json({ error: (err as Error)?.message });
        }
      },
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => null }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => null }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => null }));
vi.mock('@bike4mind/database', () => ({ imageGenerationTemplateRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  imageTemplateService: {
    listTemplates: (...a: unknown[]) => list(...a),
    getTemplate: (...a: unknown[]) => get(...a),
    saveTemplate: (...a: unknown[]) => save(...a),
    updateTemplate: (...a: unknown[]) => update(...a),
    deleteTemplate: (...a: unknown[]) => del(...a),
    recordUse: (...a: unknown[]) => recordUse(...a),
  },
}));

import collectionHandler from '../index';
import idHandler from '../[id]';
import useHandler from '../[id]/use';

const VALID_ID = '6a1fb3d3e310bb516192e8c8';
const VALID_CREATE = { name: 'Cinematic', model: 'flux-pro-1.1', settings: { quality: 'hd' } };

type Handler = (req: unknown, res: unknown) => Promise<void>;
const run = (
  handler: Handler,
  method: string,
  { id = VALID_ID, body = {}, user = { id: 'u1', isAdmin: false }, apiKeyInfo = undefined as unknown, query = {} } = {}
) => {
  const { req, res } = createMocks({ method: method as 'GET', query: { id, ...query }, body });
  (req as any).user = user;
  (req as any).apiKeyInfo = apiKeyInfo;
  return { res, promise: handler(req, res) };
};

beforeEach(() => {
  [list, get, save, update, del, recordUse].forEach(m => m.mockReset());
});

describe('GET/POST /api/image-templates', () => {
  it('lists templates (200)', async () => {
    list.mockResolvedValue([{ id: VALID_ID }]);
    const { res, promise } = run(collectionHandler as Handler, 'GET');
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ templates: [{ id: VALID_ID }] });
  });

  it('clamps an out-of-range limit before calling the service', async () => {
    list.mockResolvedValue([]);
    const { promise } = run(collectionHandler as Handler, 'GET', { query: { limit: '9999' } });
    await promise;
    expect(list).toHaveBeenCalledWith(expect.anything(), expect.anything(), { limit: 50, skip: 0 });
  });

  it('creates a template (201)', async () => {
    save.mockResolvedValue({ id: VALID_ID, ...VALID_CREATE });
    const { res, promise } = run(collectionHandler as Handler, 'POST', { body: VALID_CREATE });
    await promise;
    expect(res._getStatusCode()).toBe(201);
    expect(save).toHaveBeenCalled();
  });

  it('rejects an invalid create body with 400 (service not called)', async () => {
    const { res, promise } = run(collectionHandler as Handler, 'POST', { body: { name: 'x' } }); // no model/settings
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('maps a cap breach (service UnprocessableEntityError) to 422', async () => {
    save.mockRejectedValue(new UnprocessableEntityError('reached the limit of 50'));
    const { res, promise } = run(collectionHandler as Handler, 'POST', { body: VALID_CREATE });
    await promise;
    expect(res._getStatusCode()).toBe(422);
  });
});

describe('GET/PUT/DELETE /api/image-templates/[id]', () => {
  it('rejects an invalid id with 400 (service not called)', async () => {
    const { res, promise } = run(idHandler as Handler, 'GET', { id: 'not-an-id' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns an owned template (200)', async () => {
    get.mockResolvedValue({ id: VALID_ID });
    const { res, promise } = run(idHandler as Handler, 'GET');
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });

  it('maps a not-found (service NotFoundError) to 404', async () => {
    get.mockRejectedValue(new NotFoundError('Template not found'));
    const { res, promise } = run(idHandler as Handler, 'GET');
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('updates an owned template (200) and strips model from the body (immutable)', async () => {
    update.mockResolvedValue({ id: VALID_ID, name: 'Renamed' });
    const { res, promise } = run(idHandler as Handler, 'PUT', { body: { name: 'Renamed', model: 'gpt-image-1' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // model is omitted from the update schema, so it must not reach the service.
    expect(update).toHaveBeenCalledWith(expect.anything(), expect.anything(), VALID_ID, { name: 'Renamed' });
  });

  it('rejects an invalid update body with 400', async () => {
    const { res, promise } = run(idHandler as Handler, 'PUT', { body: { name: '' } }); // empty name fails min(1)
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('soft-deletes an owned template (204)', async () => {
    del.mockResolvedValue(undefined);
    const { res, promise } = run(idHandler as Handler, 'DELETE');
    await promise;
    expect(res._getStatusCode()).toBe(204);
  });
});

describe('POST /api/image-templates/[id]/use', () => {
  it('rejects an invalid id with 400', async () => {
    const { res, promise } = run(useHandler as Handler, 'POST', { id: 'nope' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(recordUse).not.toHaveBeenCalled();
  });

  it('records a use (204)', async () => {
    recordUse.mockResolvedValue(undefined);
    const { res, promise } = run(useHandler as Handler, 'POST', { body: {} });
    await promise;
    expect(res._getStatusCode()).toBe(204);
    expect(recordUse).toHaveBeenCalledWith(expect.anything(), expect.anything(), VALID_ID);
  });

  it('maps a not-found (service NotFoundError) to 404', async () => {
    recordUse.mockRejectedValue(new NotFoundError('Template not found'));
    const { res, promise } = run(useHandler as Handler, 'POST', { body: {} });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('maps an API-key denial (service ForbiddenError) to 403', async () => {
    recordUse.mockRejectedValue(new ForbiddenError('API keys cannot access personal image templates'));
    const { res, promise } = run(useHandler as Handler, 'POST', { body: {}, apiKeyInfo: { scopes: [] } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});
