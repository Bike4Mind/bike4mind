import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { PLANNED_INTEGRATION_IDS } from '@bike4mind/common';
import { IntegrationRequest, integrationRequestRepository } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The request route against a real mongod: idempotence rests on the unique (userId,
// integrationId) index, so a mocked repository would prove nothing. Only baseApi is mocked,
// to reach the handlers; the rate limiter it chains is covered by its own suites.

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const mockRefs = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (fn: Handler) => {
      mockRefs.handlers.GET = fn;
      return chain;
    },
    post: (fn: Handler) => {
      mockRefs.handlers.POST = fn;
      return chain;
    },
    delete: (fn: Handler) => {
      mockRefs.handlers.DELETE = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await IntegrationRequest.createIndexes();
  await import('../requests');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await IntegrationRequest.deleteMany({});
});

const call = async (
  method: RequestMethod,
  userId: string | null,
  options: { body?: Record<string, unknown>; query?: Record<string, string> } = {}
) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  if (userId) (req as unknown as { user: { id: string } }).user = { id: userId };
  await mockRefs.handlers[method](req, res);
  const raw = res._getData();
  return { status: res._getStatusCode(), body: raw ? res._getJSONData() : undefined };
};

describe('/api/integrations/requests on a real mongod', () => {
  it("records a request once however often it is sent, and reports counts and the caller's own", async () => {
    expect((await call('POST', 'u1', { body: { integrationId: 'hubspot' } })).status).toBe(204);
    expect((await call('POST', 'u1', { body: { integrationId: 'hubspot' } })).status).toBe(204);
    expect((await call('POST', 'u2', { body: { integrationId: 'hubspot' } })).status).toBe(204);
    expect((await call('POST', 'u2', { body: { integrationId: 'gmail' } })).status).toBe(204);

    expect(await call('GET', 'u1')).toEqual({
      status: 200,
      body: { counts: { hubspot: 2, gmail: 1 }, mine: ['hubspot'] },
    });
    expect(await IntegrationRequest.countDocuments({ userId: 'u1' })).toBe(1);
  });

  it('never tells a caller who else requested something, only how many', async () => {
    await IntegrationRequest.create({ userId: 'other-user-a', organizationId: 'other-org', integrationId: 'hubspot' });
    await IntegrationRequest.create({ userId: 'other-user-b', integrationId: 'gmail' });

    const { body } = await call('GET', 'u1');

    expect(Object.keys(body).sort()).toEqual(['counts', 'mine']);
    expect(body).toEqual({ counts: { hubspot: 1, gmail: 1 }, mine: [] });
    expect(JSON.stringify(body)).not.toMatch(/other-user|other-org/);
  });

  it("withdraws only the caller's own request", async () => {
    await call('POST', 'u1', { body: { integrationId: 'hubspot' } });
    await call('POST', 'u2', { body: { integrationId: 'hubspot' } });

    expect((await call('DELETE', 'u1', { query: { integrationId: 'hubspot' } })).status).toBe(204);

    expect(await call('GET', 'u1')).toEqual({ status: 200, body: { counts: { hubspot: 1 }, mine: [] } });
    expect(await call('GET', 'u2')).toEqual({ status: 200, body: { counts: { hubspot: 1 }, mine: ['hubspot'] } });
  });

  it.each([
    ['a live integration', { integrationId: 'github' }],
    ['an unknown id', { integrationId: 'not-an-integration' }],
    ['a prototype key', { integrationId: '__proto__' }],
    ['a missing id', {}],
    ['a non-string id', { integrationId: 42 }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    expect((await call('POST', 'u1', { body })).status).toBe(400);
    expect(await IntegrationRequest.countDocuments({})).toBe(0);
  });

  it('rejects a withdraw for an id that is not on the roadmap', async () => {
    expect((await call('DELETE', 'u1', { query: { integrationId: 'github' } })).status).toBe(400);
  });

  it('answers 401 without a user on every method', async () => {
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('POST', null, { body: { integrationId: 'hubspot' } })).status).toBe(401);
    expect((await call('DELETE', null, { query: { integrationId: 'hubspot' } })).status).toBe(401);
    expect(await IntegrationRequest.countDocuments({})).toBe(0);
  });

  it('leaves rows for ids no longer on the roadmap out of the response', async () => {
    await IntegrationRequest.create({ userId: 'u1', integrationId: 'github' });
    expect(await call('GET', 'u1')).toEqual({ status: 200, body: { counts: {}, mine: [] } });
  });

  it('counts only the planned ids, so rows for retired ones are never scanned', async () => {
    const counts = vi.spyOn(integrationRequestRepository, 'countsByIntegration');
    await call('GET', 'u1');
    expect(counts).toHaveBeenCalledWith(PLANNED_INTEGRATION_IDS);
    counts.mockRestore();
  });
});
