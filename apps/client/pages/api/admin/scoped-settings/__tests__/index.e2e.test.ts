// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { adminSettingsRepository, scopedSettingsRepository } from '@bike4mind/database/infra';
import { isConvergenceHalted } from '@server/queueHandlers/convergenceKillSwitch';

/**
 * Agreement test for the scoped-override write surface, driving the REAL write service, repository,
 * model and unique index against createMongoServer. The unit test beside this one mocks the service,
 * so it can pin auth, validation and delegation but not what the overlay actually does; only this
 * test proves the two things an operator depends on:
 *
 * 1. The route's own round trip - create, change in place (no duplicate row), clear, and set again
 *    at a cleared address (the tombstone-reinsert case the partial unique index exists for).
 * 2. That the lever fires: a lake-rung override written through the route changes what the REAL
 *    consumer (`isConvergenceHalted`, the background-convergence kill switch) decides, and clearing
 *    it hands the lake back to the platform value. A write surface whose writes no consumer honors
 *    is the failure this whole scoped-settings epic exists to prevent, and it is invisible to any
 *    test that stops at the repository.
 *
 * Only two seams are stubbed, neither under test: `baseApi` (auth middleware) and the lake lookup.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

// A lake the kill switch can resolve: an org-less lake, so scopeForLake puts the owner rung on the
// creating user. The id must be a real ObjectId hex - the kill switch skips the lookup for a static
// registry lake's slug id and falls through to the platform value.
const LAKE_ID = new mongoose.Types.ObjectId().toHexString();
const LAKE = { id: LAKE_ID, createdByUserId: 'user-1', organizationId: null };

const KILL_SWITCH_DEPS = {
  adminSettings: adminSettingsRepository,
  scopedSettings: scopedSettingsRepository,
  dataLakes: { findById: async () => LAKE },
} as unknown as Parameters<typeof isConvergenceHalted>[1];

const call = (
  method: 'GET' | 'PUT' | 'DELETE',
  opts: { body?: unknown; query?: Record<string, string>; isAdmin?: boolean } = {}
) => {
  const { req, res } = createMocks({ method, body: opts.body, query: opts.query });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: opts.isAdmin ?? true };
  (req as Record<string, unknown>).logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** The route throws; `errorHandler` is middleware this file does not mount, so read the status off the throw. */
const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    return 200;
  } catch (err) {
    return (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
  }
};

const messageOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('PUT/DELETE /api/admin/scoped-settings (real service, repository and Mongo)', () => {
  it('creates a row, changes it in place, clears it, and sets it again at the cleared address', async () => {
    const address = { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: LAKE_ID };

    await call('PUT', { body: { ...address, value: true } }).promise;
    let rows = await scopedSettingsRepository.find({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ settingName: 'PauseLakeConvergence', scopeLevel: 'lake', settingValue: 'true' });

    // Same address again: an upsert, so the row changes rather than a second one appearing.
    await call('PUT', { body: { ...address, value: false } }).promise;
    rows = await scopedSettingsRepository.find({});
    expect(rows).toHaveLength(1);
    expect(rows[0].settingValue).toBe('false');

    await call('DELETE', { query: address }).promise;
    expect(await scopedSettingsRepository.find({})).toHaveLength(0);

    // The tombstone-reinsert case: without the index's partialFilterExpression this throws E11000.
    await call('PUT', { body: { ...address, value: true } }).promise;
    rows = await scopedSettingsRepository.find({});
    expect(rows).toHaveLength(1);
    expect(rows[0].settingValue).toBe('true');
  });

  it('GET returns the live rows and refuses a non-admin', async () => {
    await call('PUT', {
      body: { settingName: 'dataLakeSearchMaxFiles', scopeLevel: 'organization', scopeId: 'org-1', value: 42 },
    }).promise;

    const { res, promise } = call('GET');
    await promise;
    const body = res._getJSONData() as Array<{ settingName: string; settingValue: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ settingName: 'dataLakeSearchMaxFiles', settingValue: '42' });

    expect(await statusOf(call('GET', { isAdmin: false }).promise)).toBe(403);
  });

  it('answers 400 (never 500) for every rejection the real write service raises', async () => {
    const base = { scopeLevel: 'lake', scopeId: LAKE_ID };

    // Platform-only setting: the service's settableAt gate, reached with a real settingsMap.
    expect(
      await statusOf(call('PUT', { body: { ...base, settingName: 'DefaultChunkSize', value: 900 } }).promise)
    ).toBe(400);
    // Out of range for the setting's own schema.
    expect(
      await statusOf(
        call('PUT', {
          body: { settingName: 'kbSearchMinRelevancePct', scopeLevel: 'organization', scopeId: 'o1', value: 500 },
        }).promise
      )
    ).toBe(400);
    // The ownerType biconditional, both directions.
    expect(
      await statusOf(
        call('PUT', {
          body: { settingName: 'PauseLakeConvergence', scopeLevel: 'owner', scopeId: 'u1', value: true },
        }).promise
      )
    ).toBe(400);
    expect(
      await statusOf(
        call('PUT', { body: { ...base, settingName: 'PauseLakeConvergence', value: true, ownerType: 'User' } }).promise
      )
    ).toBe(400);

    // Nothing above reached the database.
    expect(await scopedSettingsRepository.find({})).toHaveLength(0);
  });

  it('keeps the write service wording in the 400 an operator reads', async () => {
    const message = await messageOf(
      call('PUT', { body: { settingName: 'DefaultChunkSize', scopeLevel: 'lake', scopeId: LAKE_ID, value: 900 } })
        .promise
    );
    expect(message).toContain('not settable at scope level');
  });
});

describe('the lake-rung override an operator writes changes what the convergence kill switch decides', () => {
  it('halts background convergence for the lake while the override is set, and resumes once it is cleared', async () => {
    const message = { origin: 'convergence' as const, lakeId: LAKE_ID };
    const address = { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: LAKE_ID };

    // Platform value is OFF (the setting's default, no AdminSettings row), so the lake runs.
    expect(await isConvergenceHalted(message, KILL_SWITCH_DEPS)).toBe(false);

    await call('PUT', { body: { ...address, value: true } }).promise;
    // Read-your-writes: writeScopedOverride invalidated this scope's cache entry.
    expect(await isConvergenceHalted(message, KILL_SWITCH_DEPS)).toBe(true);

    await call('DELETE', { query: address }).promise;
    expect(await isConvergenceHalted(message, KILL_SWITCH_DEPS)).toBe(false);
  });

  it('pauses only the addressed lake, leaving every other lake running', async () => {
    const otherLakeId = new mongoose.Types.ObjectId().toHexString();
    await call('PUT', {
      body: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: LAKE_ID, value: true },
    }).promise;

    expect(await isConvergenceHalted({ origin: 'convergence', lakeId: LAKE_ID }, KILL_SWITCH_DEPS)).toBe(true);
    expect(
      await isConvergenceHalted({ origin: 'convergence', lakeId: otherLakeId }, {
        ...KILL_SWITCH_DEPS,
        dataLakes: { findById: async () => ({ ...LAKE, id: otherLakeId }) },
      } as unknown as Parameters<typeof isConvergenceHalted>[1])
    ).toBe(false);
  });

  it('leaves real-time user work running even while the lake is paused', async () => {
    await call('PUT', {
      body: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: LAKE_ID, value: true },
    }).promise;

    expect(await isConvergenceHalted({ origin: 'user', lakeId: LAKE_ID }, KILL_SWITCH_DEPS)).toBe(false);
  });
});
