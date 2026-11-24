import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  rateLimitOpts: [] as Array<{ bucket?: string; windowMs?: number; limit: (req: unknown) => Promise<number> }>,
  rateTier: vi.fn(async () => 30),
  setFromUpload: vi.fn(),
  setFromGeneration: vi.fn(),
  approve: vi.fn(),
  remove: vi.fn(),
  prepare: vi.fn(),
  setFreeRun: vi.fn(),
  assertAiAccess: vi.fn(),
  billingOrg: vi.fn(),
  getOrCreateSession: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const handlers: Record<string, Handler> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as Handler & Record<string, (...handlers: unknown[]) => unknown>;
    fn.use = () => fn;
    for (const method of ['get', 'post', 'put', 'delete']) {
      fn[method] = (...hs: unknown[]) => ((handlers[method.toUpperCase()] = hs[hs.length - 1] as Handler), fn);
    }
    return fn;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (opts: (typeof h.rateLimitOpts)[number]) => {
    h.rateLimitOpts.push(opts);
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: h.rateTier }));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: h.assertAiAccess }));
vi.mock('@bike4mind/server-utils/imageGenerations/imageGeneration', () => ({
  getImageGeneration: () => ({ invoke: h.invoke }),
}));
vi.mock('@bike4mind/server-utils/managers/sessionManager', () => ({ getOrCreateSession: h.getOrCreateSession }));
vi.mock('@server/billing/resolveMediaBillingOrgId', () => ({ resolveMediaBillingOrgId: h.billingOrg }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => ({ kind: 'web' }) }));
vi.mock('@server/skillMarket/template', () => ({ setOwnTemplateFreeRun: h.setFreeRun }));
vi.mock('@server/skillMarket/templateImage', async () => {
  const { ImageModels } = await import('@bike4mind/common');
  return {
    TEMPLATE_IMAGE_MODEL: ImageModels.FLUX_PRO_ULTRA,
    TEMPLATE_IMAGE_ASPECT_RATIO: '16:9',
    setOwnTemplateImageFromUpload: h.setFromUpload,
    setOwnTemplateImageFromGeneration: h.setFromGeneration,
    approveOwnTemplateImage: h.approve,
    removeOwnTemplateImage: h.remove,
    prepareTemplateImageGeneration: h.prepare,
  };
});

import { ForbiddenError, ImageModels } from '@bike4mind/common';
import imageHandler from '../image/index';
import approveHandler from '../image/approve';
import fromGenerationHandler from '../image/from-generation';
import generateHandler from '../image/generate';
import freeRunHandler from '../free-run';

const USER = { id: 'author-1', isAdmin: false };

function call(handler: unknown, method: string, body?: unknown) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: 'listing-1' }, body: body as object });
  Object.assign(req, { user: USER, logger: { warn: vi.fn() }, ability: {} });
  return { run: () => (handler as Handler)(req, res), req, res };
}

describe('template image and free-run routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prepare.mockResolvedValue({ prompt: 'PROMPT', sessionName: 'Template image for /summarize' });
    h.billingOrg.mockResolvedValue('org-1');
    h.getOrCreateSession.mockResolvedValue({ sessionId: 'session-1', asyncPromises: [] });
    h.invoke.mockResolvedValue({ id: 'quest-1' });
  });

  it('every route refuses API keys and logged-out callers (jwtOnly)', () => {
    expect(h.baseApiOptions).toHaveLength(5);
    for (const options of h.baseApiOptions) expect(options).toEqual({ auth: 'jwtOnly' });
  });

  it('limits the costly image routes hourly in their own buckets, none for a blocked tier', async () => {
    const byBucket = Object.fromEntries(h.rateLimitOpts.map(o => [o.bucket, o]));
    expect(Object.keys(byBucket).sort()).toEqual([
      'skill-market-template-image',
      'skill-market-template-image-from-generation',
      'skill-market-template-image-upload',
    ]);
    const expected: Record<string, number> = {
      'skill-market-template-image': 10,
      'skill-market-template-image-from-generation': 30,
      'skill-market-template-image-upload': 30,
    };
    for (const [bucket, { limit, windowMs }] of Object.entries(byBucket)) {
      expect(windowMs).toBe(60 * 60 * 1000);
      expect(await limit({ user: USER })).toBe(expected[bucket]);
      h.rateTier.mockResolvedValueOnce(0);
      expect(await limit({ user: USER })).toBe(0);
    }
  });

  it.each([
    ['PUT', imageHandler, h.setFromUpload, { fabFileId: 'file-1' }],
    ['DELETE', imageHandler, h.remove, undefined],
    ['POST', approveHandler, h.approve, undefined],
    ['POST', fromGenerationHandler, h.setFromGeneration, { questId: 'quest-1' }],
    ['POST', generateHandler, h.prepare, { result: 'Bullet one' }],
    ['PUT', freeRunHandler, h.setFreeRun, { enabled: true }],
  ])('%s passes the caller and listing id to the author check', async (method, handler, fn, body) => {
    fn.mockRejectedValueOnce(new ForbiddenError('not yours'));
    await expect(call(handler, method, body).run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(fn.mock.calls[0].slice(0, 2)).toEqual([USER, 'listing-1']);
  });

  it('passes the parsed body through and answers with the template', async () => {
    h.setFromUpload.mockResolvedValue({ id: 't' });
    const upload = call(imageHandler, 'PUT', { fabFileId: 'file-1' });
    await upload.run();
    expect(h.setFromUpload.mock.calls[0][2]).toBe('file-1');
    expect(upload.res._getJSONData()).toEqual({ template: { id: 't' } });

    h.setFromGeneration.mockResolvedValue({ id: 't' });
    await call(fromGenerationHandler, 'POST', { questId: 'quest-1' }).run();
    expect(h.setFromGeneration.mock.calls[0][2]).toBe('quest-1');

    h.setFreeRun.mockResolvedValue({ id: 't', freeRunEnabled: false });
    const freeRun = call(freeRunHandler, 'PUT', { enabled: false });
    await freeRun.run();
    expect(h.setFreeRun.mock.calls[0][2]).toBe(false);
    expect(freeRun.res._getJSONData()).toEqual({ template: { id: 't', freeRunEnabled: false } });
  });

  it.each([
    [imageHandler, 'PUT', {}],
    [imageHandler, 'PUT', { fabFileId: 'file-1', extra: 1 }],
    [fromGenerationHandler, 'POST', {}],
    [generateHandler, 'POST', { result: '   ' }],
    [freeRunHandler, 'PUT', { enabled: 'yes' }],
  ])('rejects a malformed body without touching the template (%#)', async (handler, method, body) => {
    await expect(call(handler, method, body).run()).rejects.toThrow();
    for (const fn of [h.setFromUpload, h.setFromGeneration, h.prepare, h.setFreeRun]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('generate queues the author-billed image generation in a new notebook and returns the quest id', async () => {
    const { run, res } = call(generateHandler, 'POST', { result: '  Bullet one  ' });
    await run();

    expect(h.assertAiAccess).toHaveBeenCalledWith(USER);
    expect(h.prepare).toHaveBeenCalledWith(USER, 'listing-1', 'Bullet one');
    expect(h.getOrCreateSession.mock.calls[0][0]).toMatchObject({
      sessionName: 'Template image for /summarize',
      user: USER,
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const { userId, body } = h.invoke.mock.calls[0][0];
    expect(userId).toBe(USER.id);
    expect(body).toMatchObject({
      model: ImageModels.FLUX_PRO_ULTRA,
      prompt: 'PROMPT',
      aspect_ratio: '16:9',
      n: 1,
      sessionId: 'session-1',
      organizationId: 'org-1',
    });
    expect(res._getJSONData()).toEqual({ questId: 'quest-1' });
  });

  it('generate stops before creating a notebook when the template check or the payer fails', async () => {
    h.prepare.mockRejectedValueOnce(new ForbiddenError('not yours'));
    await expect(call(generateHandler, 'POST', { result: 'x' }).run()).rejects.toBeInstanceOf(ForbiddenError);
    h.billingOrg.mockRejectedValueOnce(new ForbiddenError('no credits'));
    await expect(call(generateHandler, 'POST', { result: 'x' }).run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.getOrCreateSession).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
