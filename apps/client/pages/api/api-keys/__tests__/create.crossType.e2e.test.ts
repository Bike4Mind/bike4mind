import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
import { apiKeyRepository } from '@bike4mind/database';
import { ApiKeyType } from '@bike4mind/common';

/**
 * Agreement test for BYOK key creation, driving the REAL service, repository and
 * model against createMongoServer. The service unit test asserts the repository
 * CALL is type-scoped; only this test proves the scoping actually holds in Mongo,
 * because ApiKeyType's values differ from its keys (ApiKeyType.openai === 'openAi')
 * and `type` is persisted as a plain String - so the value the filter matches and
 * the value the schema stores have to agree. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

// Analytics is a side channel here and would drag in the counter service + User docs.
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => undefined) }));

import handler from '../create';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const USER = 'user-byok-1';

const addKey = async (type: ApiKeyType, apiKey: string) => {
  const { req, res } = createMocks({ method: 'POST', body: { apiKey, type } });
  (req as Record<string, unknown>).user = { id: USER };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  expect(res._getStatusCode()).toBe(200);
};

const activeByType = async () => {
  const keys = await apiKeyRepository.findAllByUserId(USER);
  return Object.fromEntries(keys.filter(k => k.isActive).map(k => [k.type, k.apiKey]));
};

describe('POST /api/api-keys/create (end-to-end, real service + repository + Mongo)', () => {
  it('keeps an existing provider key active when a key for a different provider is added', async () => {
    await addKey(ApiKeyType.elevenlabs, 'elevenlabs-value-1');
    await addKey(ApiKeyType.openai, 'openai-value-1');

    expect(await activeByType()).toEqual({
      [ApiKeyType.elevenlabs]: 'elevenlabs-value-1',
      [ApiKeyType.openai]: 'openai-value-1',
    });
  });

  it('leaves no provider stranded when a key is added for every per-user provider', async () => {
    const types = [
      ApiKeyType.openai,
      ApiKeyType.elevenlabs,
      ApiKeyType.anthropic,
      ApiKeyType.gemini,
      ApiKeyType.xai,
      ApiKeyType.kimi,
      ApiKeyType.voyageai,
    ];

    for (const type of types) {
      await addKey(type, `${type}-value`);
    }

    const active = await activeByType();
    expect(Object.keys(active).sort()).toEqual([...types].sort());
  });

  it('still supersedes the previous key of the same provider', async () => {
    await addKey(ApiKeyType.elevenlabs, 'elevenlabs-value-1');
    await addKey(ApiKeyType.openai, 'openai-value-1');
    await addKey(ApiKeyType.openai, 'openai-value-2');

    expect(await activeByType()).toEqual({
      [ApiKeyType.elevenlabs]: 'elevenlabs-value-1',
      [ApiKeyType.openai]: 'openai-value-2',
    });

    const openAiKeys = (await apiKeyRepository.findAllByUserId(USER)).filter(k => k.type === ApiKeyType.openai);
    expect(openAiKeys).toHaveLength(2);
    expect(openAiKeys.filter(k => k.isActive)).toHaveLength(1);
  });

  it('does not touch another user holding the same provider type', async () => {
    await addKey(ApiKeyType.openai, 'openai-value-1');

    const { req, res } = createMocks({
      method: 'POST',
      body: { apiKey: 'other-user-openai', type: ApiKeyType.openai },
    });
    (req as Record<string, unknown>).user = { id: 'user-byok-2' };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res._getStatusCode()).toBe(200);

    expect(await activeByType()).toEqual({ [ApiKeyType.openai]: 'openai-value-1' });
  });

  it('persists the provider as the enum value the deactivation filter matches on', async () => {
    await addKey(ApiKeyType.openai, 'openai-value-1');

    const [key] = await apiKeyRepository.findAllByUserId(USER);
    expect(key.type).toBe('openAi');
  });
});
