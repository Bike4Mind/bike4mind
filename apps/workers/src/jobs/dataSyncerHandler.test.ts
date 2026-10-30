import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

// The Resource links only MONGODB_URI: the handler must not need a prod API key.
vi.mock('sst', () => ({ Resource: { MONGODB_URI: { value: 'mongodb://target/%STAGE%' } } }));

const inserted = vi.hoisted(() => new Map<string, number>());
// Per-test knobs: an existing sync marker, a collection whose insert fails, an empty preview
// target, and an op log.
const state = vi.hoisted(() => ({
  marker: null as { syncedAt?: Date; stage?: string } | null,
  markerReadback: 'persisted' as 'persisted' | 'missing' | 'wrong-stage',
  markerReads: [] as unknown[],
  failConnect: false,
  failMarker: false,
  failInsertInto: undefined as string | undefined,
  emptyTarget: false,
  failFirstDeleteOn: undefined as string | undefined,
  ops: [] as string[],
  emptySources: [] as string[],
  cursorEmptySources: [] as string[],
  partialSource: undefined as string | undefined,
  failRollbackBulkWrite: false,
  markerWrites: [] as unknown[][],
  findFilters: [] as { name: string; filter: unknown }[],
}));

vi.mock('mongodb', () => {
  const collection = (name: string, isTarget: boolean) => {
    const docs =
      (isTarget && state.emptyTarget) || (!isTarget && state.emptySources.includes(name))
        ? []
        : [{ _id: `${name}-doc` }];
    // countDocuments and the copy cursor are separate reads: a source can report rows and then
    // yield none (rows deleted in between).
    const cursorEmpty = !isTarget && state.cursorEmptySources.includes(name);
    return {
      findOne: vi.fn(async (filter: { stage?: string }) => {
        state.markerReads.push(filter);
        if (state.markerWrites.length > 0 && state.markerReadback === 'missing') return null;
        if (state.markerWrites.length > 0 && state.markerReadback === 'wrong-stage') return { stage: 'pr999' };
        if (filter.stage && state.marker?.stage !== filter.stage) return null;
        return state.marker;
      }),
      countDocuments: vi.fn(async () =>
        !isTarget && name === state.partialSource ? 2 : cursorEmpty ? 1 : docs.length
      ),
      find: vi.fn((filter?: unknown) => {
        if (!isTarget) state.findFilters.push({ name, filter });
        const yielded = cursorEmpty ? [] : docs;
        return {
          async *[Symbol.asyncIterator]() {
            yield* yielded;
          },
          toArray: async () => yielded,
        };
      }),
      insertMany: vi.fn(async (docs: unknown[]) => {
        if (name === state.failInsertInto) throw new Error(`insert into ${name} failed`);
        inserted.set(name, (inserted.get(name) ?? 0) + docs.length);
        return { insertedCount: docs.length };
      }),
      deleteMany: vi.fn(async () => {
        state.ops.push(`${name}.deleteMany`);
        if (name === state.failFirstDeleteOn) {
          state.failFirstDeleteOn = undefined;
          throw new Error(`deleteMany on ${name} failed partway`);
        }
        return { deletedCount: 0 };
      }),
      bulkWrite: vi.fn(async () => {
        state.ops.push(`${name}.bulkWrite`);
        if (state.failRollbackBulkWrite) throw new Error(`rollback of ${name} failed`);
        return {};
      }),
      drop: vi.fn(async () => true),
      updateOne: vi.fn(
        async (filter: unknown, update: { $set: { stage?: string; syncedAt?: Date } }, options: unknown) => {
          if (state.failMarker) throw new Error('marker write failed');
          state.markerWrites.push([filter, update, options]);
          state.marker = { ...update.$set };
          return {};
        }
      ),
    };
  };
  class MongoClient {
    constructor(private uri: string) {}
    connect = vi.fn(async () => {
      if (state.failConnect) {
        const error = new Error('Cannot connect to mongodb://user:password@target/pr123');
        error.name = 'MongoServerSelectionError';
        throw error;
      }
      return this;
    });
    close = vi.fn(async () => undefined);
    db = () => ({ collection: (name: string) => collection(name, this.uri.startsWith('mongodb://target/')) });
  }
  return { MongoClient };
});

import { handler } from './dataSyncerHandler';
import { Resource } from 'sst';

const invoke = async () =>
  (await handler({ syncPreviewSettings: true }, {} as Context, () => undefined)) as {
    success: boolean;
    message: string;
    error?: string;
  };

beforeEach(() => {
  inserted.clear();
  state.markerReadback = 'persisted';
  state.markerReads = [];
  state.failConnect = false;
  state.marker = null;
  state.failInsertInto = undefined;
  state.emptyTarget = false;
  state.failFirstDeleteOn = undefined;
  state.ops = [];
  state.emptySources = [];
  state.cursorEmptySources = [];
  state.partialSource = undefined;
  state.failRollbackBulkWrite = false;
  state.markerWrites = [];
  state.failMarker = false;
  state.findFilters = [];
  vi.stubEnv('STAGING_MONGODB_URI', 'mongodb://staging/db');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dataSyncerHandler', () => {
  const env = { ...process.env };
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('copies adminsettings and rapidreplymappings from staging into a preview, with no prod fetch', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';

    const result = await invoke();

    expect(result).toMatchObject({ success: true });
    expect(result?.error).toBeUndefined();
    expect(inserted.get('adminsettings')).toBe(1);
    expect(inserted.get('rapidreplymappings')).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to sync into a non-preview stage', async () => {
    process.env.SEED_STAGE_NAME = 'staging';

    const result = await invoke();

    expect(inserted.size).toBe(0);
    expect(result?.message).toContain('Skipped staging sync: target stage "staging" is not a preview');
  });

  it('reports an already-synced preview as skipped, not as "Synced 0"', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.marker = { syncedAt: new Date('2026-09-01T00:00:00Z') };

    const result = await invoke();

    expect(inserted.size).toBe(0);
    expect(result?.message).toBe('Skipped staging sync: already synced at 2026-09-01T00:00:00.000Z');
  });

  it('clears partial inserts before restoring the backup when a collection copy fails', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.failInsertInto = 'rapidreplymappings';

    const result = await invoke();

    const ops = state.ops.filter(op => op.startsWith('rapidreplymappings.'));
    expect(ops).toEqual([
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.bulkWrite',
    ]);
    expect(result?.message).toContain('Preview settings sync failed');
  });

  it('leaves the target untouched when the backup itself fails, so a partial backup never replaces it', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.failInsertInto = 'rapidreplymappings_backup_temp';

    const result = await invoke();

    expect(state.ops.filter(op => op.startsWith('rapidreplymappings.'))).toEqual([]);
    expect(result?.message).toContain('Preview settings sync failed');
  });

  it('clears partial inserts even when the target was empty and there is no backup to restore', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.emptyTarget = true;
    state.failInsertInto = 'rapidreplymappings';

    await invoke();

    expect(state.ops.filter(op => op.startsWith('rapidreplymappings.'))).toEqual([
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.deleteMany',
    ]);
  });

  it('restores the complete backup when clearing the target fails partway', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.failFirstDeleteOn = 'rapidreplymappings';

    await invoke();

    expect(state.ops.filter(op => op.startsWith('rapidreplymappings.'))).toEqual([
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.bulkWrite',
    ]);
  });

  it('writes the sync marker after a full copy', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';

    const result = await invoke();

    expect(state.markerWrites).toHaveLength(1);
    expect(state.markerWrites[0][0]).toEqual({ key: 'staging-config-sync' });
    expect(result?.message).not.toContain('empty in source');
  });

  it('writes the marker when only some source collections are empty and does not re-copy on the next deploy', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.emptySources = ['rapidreplymappings'];

    const first = await invoke();
    const second = await invoke();

    expect(state.markerWrites).toHaveLength(1);
    expect(first?.message).toContain('empty in source: rapidreplymappings');
    expect(state.ops.filter(op => op === 'adminsettings.deleteMany')).toHaveLength(1);
    expect(second?.message).toContain('already synced');
  });

  it('withholds the marker and reports a retry when every source collection is empty', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.emptySources = ['adminsettings', 'rapidreplymappings'];

    const result = await invoke();

    expect(state.markerWrites).toHaveLength(0);
    expect(result?.message).toBe('Skipped staging sync: source empty for all collections; will retry next deploy');
  });

  it('withholds the marker when the sources report rows but copy none', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.cursorEmptySources = ['adminsettings', 'rapidreplymappings'];

    const result = await invoke();

    expect(state.markerWrites).toHaveLength(0);
    expect(result?.message).toContain('no documents copied; will retry next deploy');
  });

  it('surfaces both the copy failure and the rollback failure', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';
    state.failInsertInto = 'rapidreplymappings';
    state.failRollbackBulkWrite = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await invoke();

      expect(result?.message).toContain('insert into rapidreplymappings failed');
      expect(result?.message).toContain('rollback of rapidreplymappings failed');
      expect(state.markerWrites).toHaveLength(0);
      // The combined error keeps the original failure as its cause, so the log shows both.
      expect(errorSpy).toHaveBeenCalledWith(
        'Error syncing preview settings from staging:',
        expect.objectContaining({
          cause: expect.objectContaining({ message: 'insert into rapidreplymappings failed' }),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('excludes encrypted settings from the adminsettings source query', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';

    await invoke();

    const adminFilter = state.findFilters.find(f => f.name === 'adminsettings')?.filter as {
      settingName: { $nin: string[] };
    };
    expect(adminFilter.settingName.$nin.length).toBeGreaterThan(0);
    expect(state.findFilters.find(f => f.name === 'rapidreplymappings')?.filter).toEqual({});
  });

  it('does not copy the Turnstile settings into a preview', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';

    await invoke();

    const adminFilter = state.findFilters.find(f => f.name === 'adminsettings')?.filter as {
      settingName: { $nin: string[] };
    };
    expect(adminFilter.settingName.$nin).toEqual(
      expect.arrayContaining(['turnstileEnabled', 'turnstileFailClosed', 'turnstileSiteKey'])
    );
  });

  it('excludes ciphertext-shaped values under any name and keeps plaintext', async () => {
    process.env.SEED_STAGE_NAME = 'pr123';

    await invoke();

    const adminFilter = state.findFilters.find(f => f.name === 'adminsettings')?.filter as {
      settingValue: { $not: RegExp };
    };
    const matcher = adminFilter.settingValue.$not;
    expect(matcher).toBeInstanceOf(RegExp);
    const ciphertext = `${'a'.repeat(32)}:${'b'.repeat(32)}:${'c'.repeat(10)}`;
    expect(matcher.test(ciphertext)).toBe(true);
    expect(matcher.test(`v2:${ciphertext}`)).toBe(true);
    expect(matcher.test('Welcome aboard')).toBe(false);
  });

  it('rejects stage names that are not pr<number>', async () => {
    process.env.SEED_STAGE_NAME = 'prod';

    const result = await invoke();

    expect(inserted.size).toBe(0);
    expect(result?.message).toContain('is not a preview');
  });
});

describe('strict seed result', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const strict = (syncPreviewSettings = true) =>
    handler({ syncPreviewSettings, resultVersion: 1 }, {} as Context, () => undefined);
  beforeEach(() => {
    vi.stubEnv('SEED_STAGE_NAME', 'pr123');
    vi.stubEnv('STAGING_MONGODB_URI', 'mongodb://staging/db');
  });
  it('returns counts and a durable stage marker only after copying', async () => {
    expect(await strict()).toEqual({
      schemaVersion: 1,
      status: 'seeded',
      stage: 'pr123',
      copiedCount: 2,
      marker: { key: 'staging-config-sync', stage: 'pr123' },
    });
  });
  it.each(['missing', 'wrong-stage'] as const)('fails when marker read-back is %s', async markerReadback => {
    state.markerReadback = markerReadback;
    expect(await strict()).toEqual({ schemaVersion: 1, status: 'failed', stage: 'pr123', copiedCount: 0 });
    expect(state.markerWrites).toEqual([
      [
        { key: 'staging-config-sync' },
        { $set: { key: 'staging-config-sync', stage: 'pr123', syncedAt: expect.any(Date) } },
        { upsert: true },
      ],
    ]);
    expect(state.markerReads).toEqual([{ key: 'staging-config-sync' }, { key: 'staging-config-sync', stage: 'pr123' }]);
  });
  it.each([undefined, null, false, 'false', 'true', 0, 1, [], {}].map(value => ({ value })))(
    'rejects non-true opt-in $value without touching the database',
    async ({ value: syncPreviewSettings }) => {
      const event = { syncPreviewSettings, resultVersion: 1 } as unknown as Parameters<typeof handler>[0];
      expect(await handler(event, {} as Context, () => undefined)).toMatchObject({ status: 'misconfigured' });
      expect(state.ops).toEqual([]);
      expect(state.markerReads).toEqual([]);
      expect(state.markerWrites).toEqual([]);
      expect(inserted.size).toBe(0);
    }
  );
  it('logs a safe connection failure category without exposing credentials', async () => {
    state.failConnect = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await strict();
      expect(response).toEqual({ schemaVersion: 1, status: 'failed', stage: 'pr123', copiedCount: 0 });
      expect(errorSpy).toHaveBeenCalledWith('Preview seed failed', {
        stage: 'pr123',
        errorType: 'MongoServerSelectionError',
        errorCode: undefined,
        reason: undefined,
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('password');
    } finally {
      errorSpy.mockRestore();
    }
  });
  it('requires a marker for this stage for already-seeded success', async () => {
    state.marker = { syncedAt: new Date(), stage: 'pr123' };
    expect(await strict()).toMatchObject({
      status: 'already_seeded',
      stage: 'pr123',
      copiedCount: 0,
      marker: { stage: 'pr123' },
    });
    state.marker = { syncedAt: new Date(), stage: 'pr999' };
    expect(await strict()).toMatchObject({ status: 'failed' });
    state.marker = { syncedAt: new Date() };
    expect(await strict()).toMatchObject({ status: 'failed' });
  });
  it.each(['', 'production', 'pr0', 'pr001'])('rejects non-canonical stage %s', async stage => {
    vi.stubEnv('SEED_STAGE_NAME', stage);
    expect(await strict()).toMatchObject({ schemaVersion: 1, status: 'misconfigured' });
  });
  it('reports a missing target URI without returning an error field', async () => {
    const original = Resource.MONGODB_URI.value;
    try {
      Resource.MONGODB_URI.value = '';
      expect(await strict()).toEqual({ schemaVersion: 1, status: 'misconfigured', stage: 'pr123', copiedCount: 0 });
    } finally {
      Resource.MONGODB_URI.value = original;
    }
  });
  it('requires sync settings and a distinct staging URI', async () => {
    expect(await strict(false)).toMatchObject({ status: 'misconfigured' });
    vi.stubEnv('STAGING_MONGODB_URI', '');
    expect(await strict()).toMatchObject({ status: 'misconfigured' });
    vi.stubEnv('STAGING_MONGODB_URI', 'mongodb://target/pr123');
    expect(await strict()).toMatchObject({ status: 'misconfigured' });
  });
  it('fails empty sources and disappearing data, while allowing one empty collection', async () => {
    state.emptySources = ['adminsettings', 'rapidreplymappings'];
    expect(await strict()).toMatchObject({ status: 'failed', copiedCount: 0 });
    state.emptySources = [];
    state.cursorEmptySources = ['adminsettings', 'rapidreplymappings'];
    expect(await strict()).toMatchObject({ status: 'failed' });
    state.cursorEmptySources = ['rapidreplymappings'];
    expect(await strict()).toMatchObject({ status: 'failed' });
    state.cursorEmptySources = [];
    state.emptySources = ['rapidreplymappings'];
    expect(await strict()).toMatchObject({ status: 'seeded', copiedCount: 1 });
  });
  it('rolls back a positive but incomplete copy and withholds the marker', async () => {
    state.partialSource = 'rapidreplymappings';
    expect(await strict()).toEqual({ schemaVersion: 1, status: 'failed', stage: 'pr123', copiedCount: 0 });
    expect(inserted.get('rapidreplymappings')).toBe(1);
    expect(state.ops.filter(operation => operation.startsWith('rapidreplymappings.'))).toEqual([
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.deleteMany',
      'rapidreplymappings.bulkWrite',
    ]);
    expect(state.markerWrites).toEqual([]);
  });
  it.each(['copy', 'rollback', 'marker'])('reports %s failure without error text', async failure => {
    if (failure === 'marker') state.failMarker = true;
    else state.failInsertInto = 'rapidreplymappings';
    if (failure === 'rollback') state.failRollbackBulkWrite = true;
    expect(await strict()).toEqual({ schemaVersion: 1, status: 'failed', stage: 'pr123', copiedCount: 0 });
  });
});
