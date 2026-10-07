// @vitest-environment node
/**
 * Route tests for `GET /api/v1/models`.
 *
 * Same harness as v1Credits.test.ts: `baseApi` is stubbed but `nextRouteForContract` is
 * not, so query validation and the contract's response drift check run for real, and the
 * captured baseApi options are how the scope gate is asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  ImageModels,
  ListModelsResponseSchema,
  ModelBackend,
  getImageModelCapabilities,
  type ModelInfo,
} from '@bike4mind/common';

const { baseApiOptions, getCallerModelList } = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  getCallerModelList: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    return chain;
  },
}));

vi.mock('@server/utils/callerModelList', () => ({ getCallerModelList }));

const { default: handler } = await import('@pages/api/v1/models');

const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function textModel(id: string): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend: ModelBackend.Anthropic,
    contextWindow: 200_000,
    max_tokens: 64_000,
    supportsTools: true,
    supportsImageVariation: false,
    pricing: { 0: { input: 3, output: 15 } },
    rank: 1,
    adapterFamily: 'anthropic' as ModelInfo['adapterFamily'],
  };
}

const imageModel: ModelInfo = {
  id: ImageModels.GPT_IMAGE_1,
  type: 'image',
  name: 'GPT Image 1',
  backend: ModelBackend.OpenAI,
  contextWindow: 0,
  max_tokens: 0,
  supportsImageVariation: false,
  pricing: {},
  image: getImageModelCapabilities(ImageModels.GPT_IMAGE_1),
};

function get(query: Record<string, string> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

async function run(req: unknown, res: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCallerModelList.mockResolvedValue({
    models: [textModel('model-c'), imageModel, textModel('model-a')],
    supersededModels: [],
  });
});

describe('GET /api/v1/models', () => {
  it("lists the caller's models as the public projection, ordered by id", async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListModelsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data.map((model: { id: string }) => model.id)).toEqual(['gpt-image-1', 'model-a', 'model-c']);
    expect(body.next_cursor).toBeNull();
    expect(getCallerModelList).toHaveBeenCalledWith('u1', logger);
  });

  it('never publishes internal catalog fields', async () => {
    const { req, res } = get();

    await run(req, res);

    for (const model of res._getJSONData().data) {
      for (const internal of ['pricing', 'rank', 'adapterFamily', 'dispatchProfile', 'contextWindow']) {
        expect(model).not.toHaveProperty(internal);
      }
    }
  });

  it('carries the image block in snake_case on image models only', async () => {
    const { req, res } = get();

    await run(req, res);

    const [image, text] = res._getJSONData().data;
    expect(image.image.supports).toMatchObject({ transparent_background: true, max_reference_images: 4 });
    expect(text.image).toBeNull();
  });

  it('pages with an opaque cursor until next_cursor is null', async () => {
    const first = get({ limit: '2' });
    await run(first.req, first.res);
    const firstPage = first.res._getJSONData();

    const second = get({ limit: '2', cursor: firstPage.next_cursor });
    await run(second.req, second.res);
    const secondPage = second.res._getJSONData();

    expect(firstPage.data.map((model: { id: string }) => model.id)).toEqual(['gpt-image-1', 'model-a']);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    expect(secondPage.data.map((model: { id: string }) => model.id)).toEqual(['model-c']);
    expect(secondPage.next_cursor).toBeNull();
  });

  it('rejects a cursor minted by another endpoint with a 422', async () => {
    const foreign = Buffer.from(JSON.stringify({ v: 1, s: 'v1.data-lakes', after: 'x' })).toString('base64url');
    const { req, res } = get({ cursor: foreign });

    await expect(run(req, res)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('marks the response private and uncacheable', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('admits ai:chat and ai:generate keys, and exempts reads from the daily limit', () => {
    expect(baseApiOptions[0]).toMatchObject({
      auth: true,
      requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
      exemptReadsFromDailyRateLimit: true,
    });
  });
});
