// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { AdminSettings, User, AdminAuditLogModel as AdminAuditLog, adminAuditLogRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

const h = vi.hoisted(() => ({
  settings: { enabled: true, dailyLimit: 20, maxLive: 40, ttlDays: 1, emailDomain: null },
  beforeCreate: undefined as (() => Promise<void>) | undefined,
  issued: vi.fn(),
  deleted: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
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
    chain.post = compose;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));

vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>()),
  isProduction: () => false,
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: vi.fn() }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    userService: {
      ...actual.userService,
      createUser: async (input: unknown) => {
        const params = z
          .object({ username: z.string(), email: z.string(), record: z.record(z.string(), z.unknown()) })
          .parse(input);
        const beforeCreate = h.beforeCreate;
        h.beforeCreate = undefined;
        await beforeCreate?.();
        const created = new User({ ...params.record, username: params.username, email: params.email });
        await created.save({ validateBeforeSave: false });
        return { id: String(created._id), username: params.username, email: params.email };
      },
    },
  };
});
vi.mock('@server/personas/personaAccounts', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/personas/personaAccounts')>()),
  loadPersonaSettings: async () => h.settings,
  disableExpiredPersonas: async () => ({ disabled: 0 }),
  issuePersonaLoginCode: h.issued,
  deletePersonaAccount: h.deleted,
}));
const { default: handler } = await import('../index');
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const owner = '64b0000000000000000000a1';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await AdminSettings.collection.createIndex({ settingName: 1 }, { unique: true });
  await User.collection.createIndex({ username: 1 }, { unique: true });
  await User.collection.createIndex({ email: 1 }, { unique: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  h.settings = { enabled: true, dailyLimit: 20, maxLive: 40, ttlDays: 1, emailDomain: null };
  h.beforeCreate = undefined;
  h.issued.mockReset().mockResolvedValue({ code: 'x'.repeat(43), expiresAt: new Date(Date.now() + 300000) });
  h.deleted.mockReset().mockImplementation(async (_request: unknown, persona: { id: string }) => {
    await User.deleteOne({ _id: persona.id });
  });
  await User.collection.deleteMany({});
  await AdminAuditLog.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await AdminSettings.create({ settingName: 'PersonaMintEnabled', settingValue: true });
});
async function post(name: string, ownerId = owner) {
  const { req, res } = createMocks({ method: 'POST', url: '/api/v1/personas', body: { name } });
  Object.assign(req, { user: { id: ownerId, username: 'developer', tags: ['Developer'], isAdmin: false }, logger });
  await (handler as unknown as (request: unknown, response: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as unknown };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function concurrent(firstName: string, secondName: string, secondOwner = owner) {
  const entered = deferred();
  const release = deferred();
  h.beforeCreate = async () => {
    entered.resolve();
    await release.promise;
  };
  const guard = vi.spyOn(AdminSettings, 'updateOne');
  const first = post(firstName);
  await Promise.race([
    entered.promise,
    first.then(() => {
      throw new Error('First mint never reached creation');
    }),
  ]);
  const second = post(secondName, secondOwner);
  const settled = Promise.allSettled([first, second]);
  try {
    await vi.waitFor(() => expect(guard.mock.calls.length).toBeGreaterThanOrEqual(2));
  } finally {
    release.resolve();
    await settled;
  }
  return Promise.all([first, second]);
}

describe('persona mint transaction against real MongoDB', () => {
  it('serializes the live cap with creation and audit', async () => {
    h.settings.maxLive = 1;
    expect((await concurrent('alpha', 'beta')).map(result => result.status)).toEqual([201, 429]);
    expect(await User.countDocuments({ isPersona: true })).toBe(1);
    expect(await AdminAuditLog.countDocuments({ action: 'user.persona.created' })).toBe(1);
  });
  it('enforces rolling audit counts across a fresh fixed-counter window', async () => {
    const occurredAt = new Date(Date.now() - 60 * 60 * 1000);
    await AdminAuditLog.collection.insertMany(
      Array.from({ length: 19 }, () => ({ action: 'user.persona.created', occurredAt }))
    );
    expect((await concurrent('alpha', 'beta')).map(result => result.status)).toEqual([201, 429]);
    expect(await AdminAuditLog.countDocuments({ action: 'user.persona.created' })).toBe(20);
    expect(await User.countDocuments({ isPersona: true })).toBe(1);
  });
  it('preserves one live name across owners and reuses it for its owner', async () => {
    const results = await concurrent('alpha', 'alpha', '64b0000000000000000000a2');
    expect(results.map(result => result.status)).toEqual([201, 409]);
    expect(await User.countDocuments({ personaName: 'alpha' })).toBe(1);
    const repeated = await post('alpha');
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ created: false });
    expect(await AdminAuditLog.countDocuments({ action: 'user.persona.created' })).toBe(1);
  });
  it.each(['missing', 'disabled'])('refuses a %s persisted switch despite a stale enabled read', async state => {
    if (state === 'missing') await AdminSettings.deleteMany({});
    else await AdminSettings.updateOne({ settingName: 'PersonaMintEnabled' }, { $set: { settingValue: false } });
    expect((await post('alpha')).status).toBe(404);
    expect(await User.countDocuments()).toBe(0);
    expect(h.issued).not.toHaveBeenCalled();
  });
  it('rolls creation and the shared guard back when strict audit fails', async () => {
    vi.spyOn(adminAuditLogRepository, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(post('alpha')).rejects.toThrow('audit unavailable');
    expect(await User.countDocuments()).toBe(0);
    expect(await AdminAuditLog.countDocuments()).toBe(0);
    expect(h.issued).not.toHaveBeenCalled();
    expect((await post('alpha')).status).toBe(201);
  });
  it('deletes a disabled name outside the transaction, then rechecks the name', async () => {
    await User.collection.insertOne({
      username: 'persona-alpha-1',
      email: 'old@example.test',
      isPersona: true,
      isBanned: true,
      personaName: 'alpha',
      personaOwnerId: owner,
      personaExpiresAt: new Date(Date.now() - 1000),
    });
    expect((await post('alpha')).status).toBe(201);
    expect(h.deleted).toHaveBeenCalledTimes(1);
    expect(await User.countDocuments({ personaName: 'alpha' })).toBe(1);
  });
});
