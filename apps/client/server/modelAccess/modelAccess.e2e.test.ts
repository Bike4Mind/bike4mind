import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  ModelAccessBulkDryRun,
  ModelAccessBulkResult,
  ModelAccessPatchResult,
  ModelAccessSaveResult,
} from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { AdminAuditLogModel, AdminSettings, Cache, User, cacheRepository } from '@bike4mind/database';
import { resolveAdminModelFilterIds } from '@server/admin/models/adminModelFilter';
import { commitAccessEntry } from './modelAccessStore';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const routes = vi.hoisted(() => ({}) as Record<string, Handler>);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = { use: () => chain };
    for (const method of ['get', 'post', 'patch', 'put']) {
      chain[method] = (fn: Handler) => {
        routes[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/admin/models/adminModelFilter', () => ({ resolveAdminModelFilterIds: vi.fn() }));
vi.mock('./modelAccessStore', async importOriginal => {
  const original = await importOriginal<typeof import('./modelAccessStore')>();
  return { ...original, commitAccessEntry: vi.fn(original.commitAccessEntry) };
});

const { commitAccessEntry: realCommit } =
  await vi.importActual<typeof import('./modelAccessStore')>('./modelAccessStore');

await import('../../pages/api/admin/models/access/index');
const patchRoute = routes.patch;
await import('../../pages/api/admin/models/access/bulk');
const bulkRoute = routes.post;
await import('../../pages/api/admin/users/tags');
const tagsRoute = routes.get;
await import('../../pages/api/admin/llm-models/configurations');
const saveRoute = routes.put;

const ADMIN = {
  id: '650000000000000000000002',
  name: 'Test Admin',
  username: 'admin',
  isAdmin: true,
  adminPermissions: [],
};
const DELEGATE = { ...ADMIN, id: '650000000000000000000003', isAdmin: false, adminPermissions: ['settings:manage'] };
const NAME = 'llmModelConfigurations';
const REASON = 'testing access changes';

async function call<T>(
  handler: Handler,
  { body = {}, query = {}, user = ADMIN }: { body?: unknown; query?: Record<string, unknown>; user?: unknown } = {}
): Promise<T> {
  const res = { json: vi.fn(), setHeader: vi.fn() };
  await handler(
    {
      method: 'POST',
      body,
      query,
      user,
      headers: {},
      url: '/api/admin/models/access',
      logger: { log: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    },
    res
  );
  return res.json.mock.calls[0][0] as T;
}

const patch = (id: string, body: Record<string, unknown>, user: unknown = ADMIN) =>
  call<ModelAccessPatchResult>(patchRoute, { query: { id }, body: { reason: REASON, ...body }, user });
const bulk = <T>(body: Record<string, unknown>, user: unknown = ADMIN) => call<T>(bulkRoute, { body, user });
const dryRun = (ids: string[], change: Record<string, unknown>) =>
  bulk<ModelAccessBulkDryRun>({ selection: { ids }, change });
const save = (changes: unknown[], extra: Record<string, unknown> = {}) =>
  call<ModelAccessSaveResult>(saveRoute, { body: { changes, reason: REASON, ...extra } });
const apply = (ids: string[], change: Record<string, unknown>, token: string) =>
  bulk<ModelAccessBulkResult>({ selection: { ids }, change, reason: REASON, dryRunToken: token });

const stamp = (iso: string) => new Date(iso);
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  allowedUserTags: [],
  allowedEntitlements: ['base'],
  updatedAt: stamp('2026-11-01T00:00:00.000Z'),
  ...extra,
});

async function seed(entries: Record<string, unknown>[]) {
  await AdminSettings.collection.insertOne({
    settingName: NAME,
    settingValue: entries,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const storedValue = async () =>
  ((await AdminSettings.collection.findOne({ settingName: NAME }))?.settingValue ?? []) as Record<string, unknown>[];
const stored = async (id: string) => (await storedValue()).find(item => item.id === id);
const bson = (value: unknown) => mongoose.mongo.BSON.serialize({ value });
const settingRow = (settingName: string) => AdminSettings.collection.findOne({ settingName });
const audits = () => AdminAuditLogModel.find({}).lean();

let server: MongoMemoryReplSet;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  // Every deployment has the cache's unique key index; the single-use claim on a dry-run token relies on it.
  await Cache.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  vi.mocked(commitAccessEntry).mockImplementation(realCommit);
  vi.mocked(resolveAdminModelFilterIds).mockReset();
  for (const model of [AdminSettings, AdminAuditLogModel, User, Cache]) await model.collection.deleteMany({});
});

describe('PATCH /api/admin/models/access', () => {
  it('changes exactly one entry, audits only that model and bumps only the access revision', async () => {
    await seed([entry('model-a'), entry('model-b'), entry('model-c', { allowedUserTags: ['beta'], rank: 3 })]);
    const before = await storedValue();

    const result = await patch('model-b', {
      change: { enabled: false },
      expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
    });

    const after = await storedValue();
    expect(after).toHaveLength(3);
    expect(Buffer.compare(bson(after[0]), bson(before[0]))).toBe(0);
    expect(Buffer.compare(bson(after[2]), bson(before[2]))).toBe(0);
    expect(after[1]).toMatchObject({ id: 'model-b', enabled: false, allowedEntitlements: ['base'] });
    expect(after[1].updatedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ changed: true, entry: { id: 'model-b', enabled: false } });
    expect(result.entry?.updatedAt).toBe((after[1].updatedAt as Date).toISOString());

    const written = await audits();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: `${NAME}:model-b` },
      reason: REASON,
      details: { modelId: 'model-b' },
    });
    expect(JSON.stringify(written[0].changes)).not.toMatch(/model-a|model-c/);

    expect((await settingRow('modelAccessRevision'))?.settingValue).toBe(result.revision);
    expect(await settingRow('modelListRevision')).toBeNull();
  });

  it('refuses a stale expectedUpdatedAt with 409 and leaves the document unchanged', async () => {
    await seed([entry('model-a'), entry('model-b')]);
    const before = await storedValue();

    await expect(
      patch('model-a', { change: { enabled: false }, expectedUpdatedAt: '2026-10-01T00:00:00.000Z' })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(Buffer.compare(bson(await storedValue()), bson(before))).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it('a conditional write on a stale stamp matches nothing and changes nothing', async () => {
    await seed([entry('model-a'), entry('model-b')]);
    const before = await storedValue();
    const req = { user: ADMIN, headers: {}, url: '/api/admin/models/access' } as never;

    const outcome = await realCommit(req, {
      id: 'model-a',
      expected: stamp('2026-10-01T00:00:00.000Z'),
      before: null,
      next: { ...entry('model-a', { enabled: false }), updatedAt: new Date() },
      reason: REASON,
    });

    expect(outcome).toBe('stale');
    expect(Buffer.compare(bson(await storedValue()), bson(before))).toBe(0);
  });

  it('creates the document on the first write, and tagging a model with no entry writes enabled: true', async () => {
    await AdminSettings.init();

    const result = await patch('local-image/anime/foo v2.safetensors', {
      change: { allowedUserTags: ['beta'] },
      expectedUpdatedAt: null,
    });

    expect(await AdminSettings.collection.countDocuments({ settingName: NAME })).toBe(1);
    expect(await storedValue()).toEqual([
      {
        id: 'local-image/anime/foo v2.safetensors',
        enabled: true,
        allowedUserTags: ['beta'],
        allowedEntitlements: ['base'],
        updatedAt: expect.any(Date),
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it('a duplicate create returns 409 and never inserts a second document', async () => {
    // As on a fresh deployment: autoIndex on, no settingName index yet, and no init() run, so only the create
    // path's own AdminSettings.init() can build the index the duplicate has to collide with.
    await AdminSettings.collection.dropIndexes();
    const previousAutoIndex = AdminSettings.schema.get('autoIndex');
    AdminSettings.schema.set('autoIndex', true);
    (AdminSettings as unknown as { $init?: Promise<unknown> }).$init = undefined;
    const settingNameIsUnique = async () =>
      (await AdminSettings.collection.indexes()).some(index => index.key.settingName === 1 && index.unique);
    expect(await settingNameIsUnique()).toBe(false);

    try {
      await patch('model-x', { change: { allowedUserTags: ['beta'] }, expectedUpdatedAt: null });
    } finally {
      AdminSettings.schema.set('autoIndex', previousAutoIndex);
    }
    expect(await settingNameIsUnique()).toBe(true);

    await expect(
      patch('model-x', { change: { allowedUserTags: ['gamma'] }, expectedUpdatedAt: null })
    ).rejects.toMatchObject({ statusCode: 409 });

    // The write path itself: a create racing past the read collides on the unique settingName index.
    const outcome = await realCommit({ user: ADMIN, headers: {}, url: '/x' } as never, {
      id: 'model-x',
      expected: null,
      before: null,
      next: { ...entry('model-x', { allowedUserTags: ['gamma'] }), updatedAt: new Date() },
      reason: REASON,
    });
    expect(outcome).toBe('stale');
    expect(await AdminSettings.collection.countDocuments({ settingName: NAME })).toBe(1);
    expect((await stored('model-x'))?.allowedUserTags).toEqual(['beta']);
  });

  it('updates an entry stored before per-entry stamps when the caller read no stamp', async () => {
    await seed([{ id: 'legacy', enabled: true, allowedUserTags: ['customer'] }]);

    await patch('legacy', { change: { enabled: false }, expectedUpdatedAt: null });

    expect(await storedValue()).toEqual([
      { id: 'legacy', enabled: false, allowedUserTags: ['customer'], updatedAt: expect.any(Date) },
    ]);
  });

  it('requires an explicit confirm before leaving a model visible only to admins', async () => {
    await seed([entry('model-a')]);
    const body = {
      change: { allowedEntitlements: [] },
      expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
    };

    await expect(patch('model-a', body)).rejects.toMatchObject({ statusCode: 422 });
    await expect(patch('model-a', { ...body, confirmAdminOnly: true })).resolves.toMatchObject({ changed: true });
  });

  it('refuses a delegate holding settings:manage with 403', async () => {
    await seed([entry('model-a')]);

    await expect(
      patch('model-a', { change: { enabled: false }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }, DELEGATE)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await stored('model-a'))?.enabled).toBe(true);
  });
});

describe('POST /api/admin/models/access/bulk', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `model-${index}`);

  it('applies a dry run per entry, one audit entry per model under one batch id, and one revision bump', async () => {
    await seed([...ids.slice(0, 9).map(id => entry(id)), entry('model-9', { allowedUserTags: ['beta'] })]);

    const preview = await dryRun(ids, { addTags: ['beta'] });
    expect(preview.counts).toMatchObject({ selected: 10, change: 9, unchanged: 1, noAudienceChange: 9 });
    expect(preview.items[0]).toMatchObject({ audience: 'none', everyoneThroughBase: true, changes: true });

    const result = await apply(ids, { addTags: ['beta'] }, preview.token);

    expect(result.summary).toBe('Updated 9 of 9');
    expect(result.counts).toEqual({ selected: 10, updated: 9, unchanged: 1, failed: 0 });
    const written = await audits();
    expect(written).toHaveLength(9);
    expect(new Set(written.map(row => (row.details as { batchId?: string }).batchId))).toEqual(
      new Set([result.batchId])
    );
    expect((await settingRow('modelAccessRevision'))?.settingValue).toBe(result.revision);
    expect(await settingRow('modelListRevision')).toBeNull();
  });

  it('returns 409 with a fresh dry run when a stamp moves between dry run and apply', async () => {
    await seed(ids.map(id => entry(id)));
    const preview = await dryRun(ids, { enabled: false });
    await patch('model-4', { change: { rank: 7 }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' });

    const conflict = await apply(ids, { enabled: false }, preview.token).catch(error => error);

    expect(conflict).toMatchObject({ statusCode: 409 });
    const fresh = conflict.additionalInfo.dryRun as ModelAccessBulkDryRun;
    expect(fresh.items.find(item => item.id === 'model-4')?.before?.rank).toBe(7);
    expect((await storedValue()).every(item => item.enabled === true)).toBe(true);

    await expect(apply(ids, { enabled: false }, fresh.token)).resolves.toMatchObject({ summary: 'Updated 10 of 10' });
  });

  it('takes at most 500 ids in one selection', async () => {
    const named = (count: number) => Array.from({ length: count }, (_, index) => `model-${index}`);

    await expect(bulk({ selection: { ids: named(501) }, change: { enabled: false } })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await dryRun(named(500), { enabled: false })).counts.selected).toBe(500);
  });

  it('returns 409 when the id set differs from the dry run', async () => {
    await seed(ids.map(id => entry(id)));
    const preview = await dryRun(ids.slice(0, 5), { enabled: false });

    await expect(apply(ids.slice(0, 6), { enabled: false }, preview.token)).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { dryRun: { ids: ids.slice(0, 6) } },
    });
  });

  describe('selecting by filter', () => {
    const filter = { view: 'hidden', providers: ['openai'] };
    const resolved = vi.mocked(resolveAdminModelFilterIds);
    const filterDryRun = () => bulk<ModelAccessBulkDryRun>({ selection: { filter }, change: { enabled: true } });

    it('previews exactly the ids the list filter resolves to, sorted', async () => {
      await seed(ids.map(id => entry(id, { enabled: false })));
      resolved.mockResolvedValue(['model-3', 'model-1', 'model-2']);

      const preview = await filterDryRun();

      expect(resolved).toHaveBeenCalledWith({ ...filter, showFoundationIds: false });
      expect(preview.ids).toEqual(['model-1', 'model-2', 'model-3']);
      expect(preview.counts).toMatchObject({ selected: 3, change: 3 });
    });

    it('applies when the filter still matches the previewed models', async () => {
      await seed(ids.map(id => entry(id, { enabled: false })));
      resolved.mockResolvedValue(['model-1', 'model-2']);
      const preview = await filterDryRun();

      const result = await bulk<ModelAccessBulkResult>({
        selection: { filter },
        change: { enabled: true },
        reason: REASON,
        dryRunToken: preview.token,
      });

      expect(result.summary).toBe('Updated 2 of 2');
      expect(await stored('model-1')).toMatchObject({ enabled: true });
      expect(await stored('model-3')).toMatchObject({ enabled: false });
    });

    it('returns 409 with a fresh preview when the filter matches other models at apply time', async () => {
      await seed(ids.map(id => entry(id, { enabled: false })));
      resolved.mockResolvedValue(['model-1', 'model-2']);
      const preview = await filterDryRun();
      resolved.mockResolvedValue(['model-1', 'model-2', 'model-4']);

      await expect(
        bulk({ selection: { filter }, change: { enabled: true }, reason: REASON, dryRunToken: preview.token })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: 'This preview no longer applies. Review the new one and apply again.',
        additionalInfo: { dryRun: { ids: ['model-1', 'model-2', 'model-4'] } },
      });
      expect(await stored('model-1')).toMatchObject({ enabled: false });
    });

    it('returns 422 when the filter matches no models', async () => {
      resolved.mockResolvedValue([]);

      await expect(filterDryRun()).rejects.toMatchObject({
        statusCode: 422,
        message: 'No models match this filter.',
        additionalInfo: { matched: 0 },
      });
    });

    it('returns 422 when the filter matches more than 500 models', async () => {
      const matched = 501;
      resolved.mockResolvedValue(Array.from({ length: matched }, (_, index) => `model-${index}`));

      await expect(filterDryRun()).rejects.toMatchObject({
        statusCode: 422,
        message: 'This filter matches 501 models. Narrow it to 500 or fewer.',
        additionalInfo: { matched },
      });
    });

    it('returns 400 for a filter the list does not accept, before resolving it', async () => {
      for (const bad of [{ view: 'everything' }, { search: 'gpt', sortBy: 'name' }]) {
        await expect(bulk({ selection: { filter: bad }, change: { enabled: true } })).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      expect(resolved).not.toHaveBeenCalled();
    });
  });

  it('reports partial failures per id, and a retry of the failed ids completes them', async () => {
    await seed(ids.map(id => entry(id)));
    const failing = new Set(['model-2', 'model-5', 'model-8']);
    vi.mocked(commitAccessEntry).mockImplementation(async (req, commit) => {
      if (failing.has(commit.id)) throw new Error('write failed');
      return realCommit(req, commit);
    });

    const preview = await dryRun(ids, { addTags: ['beta'], alsoRemoveBase: true });
    const result = await apply(ids, { addTags: ['beta'], alsoRemoveBase: true }, preview.token);

    expect(result.summary).toBe('Updated 7 of 10. 3 failed');
    expect(result.results.filter(item => item.outcome === 'failed')).toEqual(
      [...failing].map(id => ({ id, outcome: 'failed', reason: 'write-error' }))
    );

    vi.mocked(commitAccessEntry).mockImplementation(realCommit);
    const failed = result.results.filter(item => item.outcome === 'failed').map(item => item.id);
    const retryPreview = await dryRun(failed, { addTags: ['beta'], alsoRemoveBase: true });
    const retry = await apply(failed, { addTags: ['beta'], alsoRemoveBase: true }, retryPreview.token);

    expect(retry.summary).toBe('Updated 3 of 3');
    for (const item of await storedValue()) {
      expect(item).toMatchObject({ allowedUserTags: ['beta'] });
      expect(item.allowedEntitlements).toBeUndefined();
    }
  });

  it('undo reverts the batch, including entries the batch created', async () => {
    await seed([entry('model-0', { allowedUserTags: ['alpha'], allowedEntitlements: ['acme:pro'] })]);
    const before = await stored('model-0');
    const preview = await dryRun(['model-0', 'model-1'], { addTags: ['alpha', 'beta'] });
    const result = await apply(['model-0', 'model-1'], { addTags: ['alpha', 'beta'] }, preview.token);
    expect(await stored('model-1')).toMatchObject({ enabled: true, allowedUserTags: ['alpha', 'beta'] });

    const undo = await bulk<ModelAccessBulkResult>({ undoToken: result.undoToken, reason: REASON });

    expect(undo.summary).toBe('Updated 2 of 2');
    expect(await stored('model-1')).toBeUndefined();
    const restored = await stored('model-0');
    expect(restored).toMatchObject({ allowedUserTags: ['alpha'], allowedEntitlements: ['acme:pro'] });
    expect((restored?.updatedAt as Date).getTime()).toBeGreaterThan((before?.updatedAt as Date).getTime());
    const undoAudits = (await audits()).filter(row => (row.details as { undoOf?: string }).undoOf === result.batchId);
    expect(undoAudits).toHaveLength(2);
  });

  it('refuses a replayed preview with 409 after its batch was undone, and applies nothing', async () => {
    const change = { addTags: ['beta'] };
    const preview = await dryRun(['model-0', 'model-1'], change);
    const result = await apply(['model-0', 'model-1'], change, preview.token);
    await bulk<ModelAccessBulkResult>({ undoToken: result.undoToken, reason: REASON });
    expect(await storedValue()).toEqual([]);

    await expect(apply(['model-0', 'model-1'], change, preview.token)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This preview was already applied. Review the new one and apply again.',
      additionalInfo: { dryRun: { ids: ['model-0', 'model-1'] } },
    });
    expect(await storedValue()).toEqual([]);
  });

  it('answers a claim that loses on a duplicate key with the same 409, not a 500', async () => {
    await seed(ids.map(id => entry(id)));
    const preview = await dryRun(ids, { enabled: false });
    const claim = vi
      .spyOn(cacheRepository, 'claimDedup')
      .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));

    try {
      await expect(apply(ids, { enabled: false }, preview.token)).rejects.toMatchObject({
        statusCode: 409,
        message: 'This preview was already applied. Review the new one and apply again.',
        additionalInfo: { dryRun: { ids } },
      });
    } finally {
      claim.mockRestore();
    }
    expect(await audits()).toHaveLength(0);
    expect(await stored('model-0')).toMatchObject({ enabled: true });
  });

  it('applies a preview submitted twice at once exactly once', async () => {
    await seed(ids.map(id => entry(id)));
    const preview = await dryRun(ids, { enabled: false });

    const outcomes = await Promise.allSettled([
      apply(ids, { enabled: false }, preview.token),
      apply(ids, { enabled: false }, preview.token),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(await audits()).toHaveLength(ids.length);
  });

  it('"Also remove base" narrows models to the tag, and its undo restores base and drops the tag in one write each', async () => {
    await seed(['model-0', 'model-1', 'model-2'].map(id => entry(id)));
    const selection = ['model-0', 'model-1', 'model-2'];

    const plain = await dryRun(selection, { addTags: ['beta'] });
    expect(plain.items.every(item => item.audience === 'none' && item.everyoneThroughBase)).toBe(true);

    const narrowing = await dryRun(selection, { addTags: ['beta'], alsoRemoveBase: true });
    expect(narrowing.items.every(item => item.audience === 'narrower' && !item.everyoneThroughBase)).toBe(true);
    const result = await apply(selection, { addTags: ['beta'], alsoRemoveBase: true }, narrowing.token);
    for (const id of selection) {
      const item = await stored(id);
      expect(item?.allowedUserTags).toEqual(['beta']);
      expect(item?.allowedEntitlements).toBeUndefined();
    }

    vi.mocked(commitAccessEntry).mockClear();
    await bulk({ undoToken: result.undoToken, reason: REASON });

    expect(vi.mocked(commitAccessEntry)).toHaveBeenCalledTimes(3);
    for (const id of selection) {
      expect(await stored(id)).toMatchObject({ allowedUserTags: [], allowedEntitlements: ['base'] });
    }
  });

  it('removeTags with alsoRestoreBase is the single-call inverse of addTags with alsoRemoveBase', async () => {
    await seed([entry('model-0', { allowedUserTags: ['beta'], allowedEntitlements: [] })]);

    const preview = await dryRun(['model-0'], { removeTags: ['beta'], alsoRestoreBase: true });
    expect(preview.items[0]).toMatchObject({ audience: 'wider', adminOnly: false });
    await apply(['model-0'], { removeTags: ['beta'], alsoRestoreBase: true }, preview.token);

    expect(await stored('model-0')).toMatchObject({ allowedUserTags: [], allowedEntitlements: ['base'] });
  });

  it('refuses a delegate holding settings:manage with 403', async () => {
    await expect(bulk({ selection: { ids }, change: { enabled: false } }, DELEGATE)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('GET /api/admin/users/tags', () => {
  it('counts live accounts per lower-cased tag and leaves out source: tags', async () => {
    await User.collection.insertMany([
      { name: 'one', tags: ['Beta', 'beta', 'source:acme'] },
      { name: 'two', tags: ['beta', 'gamma'] },
      { name: 'gone', tags: ['beta', 'delta'], deletedAt: new Date() },
      { name: 'none', tags: [] },
    ]);

    const { tags } = await call<{ tags: { tag: string; count: number }[] }>(tagsRoute);

    expect(tags).toEqual([
      { tag: 'beta', count: 2 },
      { tag: 'gamma', count: 1 },
    ]);
  });

  it('serves the counts from a short-lived cache row, which also leaves out source: tags', async () => {
    await User.collection.insertMany([{ name: 'one', tags: ['beta', 'source:acme'] }]);
    const first = await call<{ tags: { tag: string; count: number }[] }>(tagsRoute);
    await User.collection.insertOne({ name: 'two', tags: ['gamma', 'source:other'] });

    const cached = await call<{ tags: { tag: string; count: number }[] }>(tagsRoute);
    expect(cached).toEqual(first);
    expect(cached.tags).toEqual([{ tag: 'beta', count: 1 }]);

    await Cache.collection.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await call<{ tags: { tag: string; count: number }[] }>(tagsRoute);
    expect(fresh.tags).toEqual([
      { tag: 'beta', count: 1 },
      { tag: 'gamma', count: 1 },
    ]);
  });

  it('refuses a delegate with 403', async () => {
    await expect(call(tagsRoute, { user: DELEGATE })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('atomic dashboard compatibility Save', () => {
  it('changes only requested entries, preserving unrelated concurrent edits and routing fields', async () => {
    await seed([entry('a', { fallbackModel: 'fallback', rank: 3 }), entry('b', { rank: 40 })]);
    const unrelated = bson(await stored('b'));
    const result = await save([{ id: 'a', change: { enabled: false }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }]);
    expect(result.changed).toBe(1);
    expect(await stored('a')).toMatchObject({ enabled: false, fallbackModel: 'fallback', rank: 3 });
    expect(Buffer.compare(bson(await stored('b')), unrelated)).toBe(0);
    expect(await audits()).toHaveLength(1);
  });

  it('refuses a stale changed entry before any writes or audits', async () => {
    await seed([entry('a'), entry('b')]);
    const before = bson(await storedValue());
    await expect(
      save([
        { id: 'a', change: { enabled: false }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' },
        { id: 'b', change: { enabled: false }, expectedUpdatedAt: '2026-10-01T00:00:00.000Z' },
      ])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(Buffer.compare(bson(await storedValue()), before)).toBe(0);
    expect(await audits()).toHaveLength(0);
    expect(await settingRow('modelAccessRevision')).toBeNull();
  });

  it('rolls earlier entry writes and audits back if a later conditional write loses its stamp', async () => {
    await seed([entry('a'), entry('b', { updatedAt: stamp('2026-11-02T00:00:00.000Z') })]);
    const before = bson(await storedValue());
    const { commitAccessEntries } = await vi.importActual<typeof import('./modelAccessStore')>('./modelAccessStore');
    const outcome = await commitAccessEntries({ user: ADMIN, headers: {}, url: '/test' } as never, [
      {
        id: 'a',
        expected: stamp('2026-11-01T00:00:00.000Z'),
        before: { ...entry('a'), allowedUserTags: [] },
        next: { ...entry('a'), allowedUserTags: [], enabled: false, updatedAt: new Date() },
        reason: REASON,
      },
      {
        id: 'b',
        expected: stamp('2026-11-01T00:00:00.000Z'),
        before: { ...entry('b'), allowedUserTags: [] },
        next: { ...entry('b'), allowedUserTags: [], enabled: false, updatedAt: new Date() },
        reason: REASON,
      },
    ]);
    expect(outcome).toBe('stale');
    expect(Buffer.compare(bson(await storedValue()), before)).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it('rolls the entire Save back when its second strict audit fails', async () => {
    await seed([entry('a'), entry('b')]);
    const before = bson(await storedValue());
    const original = AdminAuditLogModel.collection.insertOne.bind(AdminAuditLogModel.collection);
    let writes = 0;
    const spy = vi
      .spyOn(AdminAuditLogModel.collection, 'insertOne')
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        writes += 1;
        if (writes === 2) throw new Error('Second strict audit failed');
        return original(...args);
      });
    try {
      await expect(
        save(['a', 'b'].map(id => ({ id, change: { enabled: false }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' })))
      ).rejects.toThrow('Second strict audit failed');
    } finally {
      spy.mockRestore();
    }
    expect(writes).toBe(2);
    expect(Buffer.compare(bson(await storedValue()), before)).toBe(0);
    expect(await audits()).toHaveLength(0);
    expect(await settingRow('modelAccessRevision')).toBeNull();
  });

  it('supports mixed creates and updates, including explicit fallback/rank removal', async () => {
    await seed([entry('a', { fallbackModel: 'fallback', rank: 3 })]);
    const result = await save([
      { id: 'a', change: { fallbackModel: null, rank: null }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'new/local:model', change: { enabled: false, allowedUserTags: ['beta'] }, expectedUpdatedAt: null },
    ]);
    expect(result.changed).toBe(2);
    expect(await stored('a')).not.toHaveProperty('fallbackModel');
    expect(await stored('a')).not.toHaveProperty('rank');
    expect(await stored('new/local:model')).toMatchObject({ enabled: false, allowedUserTags: ['beta'] });
    expect(await audits()).toHaveLength(2);
    expect((await settingRow('modelAccessRevision'))?.settingValue).toBe(result.revision);
  });

  it('requires explicit confirmation for an admin-only changed audience', async () => {
    await seed([entry('a')]);
    const changes = [{ id: 'a', change: { allowedEntitlements: [] }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }];
    await expect(save(changes)).rejects.toMatchObject({ statusCode: 422 });
    expect(await audits()).toHaveLength(0);
    expect((await save(changes, { confirmAdminOnly: true })).changed).toBe(1);
  });

  it('does not audit or bump revision for unchanged fields or an empty diff', async () => {
    await seed([entry('a')]);
    expect(
      (await save([{ id: 'a', change: { enabled: true }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }])).changed
    ).toBe(0);
    expect((await save([])).changed).toBe(0);
    expect(await audits()).toHaveLength(0);
    expect(await settingRow('modelAccessRevision')).toBeNull();
  });
});
