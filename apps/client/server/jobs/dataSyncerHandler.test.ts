import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

// The Resource links only MONGODB_URI: the handler must not need a prod API key.
vi.mock('sst', () => ({ Resource: { MONGODB_URI: { value: 'mongodb://target/%STAGE%' } } }));

const inserted = vi.hoisted(() => new Map<string, number>());
// Per-test knobs: an existing sync marker, a collection whose insert fails, and an op log.
const state = vi.hoisted(() => ({
  marker: null as { syncedAt: Date } | null,
  failInsertInto: undefined as string | undefined,
  ops: [] as string[],
}));

vi.mock('mongodb', () => {
  const collection = (name: string) => ({
    findOne: vi.fn(async () => state.marker),
    countDocuments: vi.fn(async () => 1),
    find: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { _id: `${name}-doc` };
      },
      toArray: async () => [{ _id: `${name}-doc` }],
    })),
    insertMany: vi.fn(async (docs: unknown[]) => {
      if (name === state.failInsertInto) throw new Error(`insert into ${name} failed`);
      inserted.set(name, (inserted.get(name) ?? 0) + docs.length);
      return { insertedCount: docs.length };
    }),
    deleteMany: vi.fn(async () => {
      state.ops.push(`${name}.deleteMany`);
      return { deletedCount: 0 };
    }),
    bulkWrite: vi.fn(async () => {
      state.ops.push(`${name}.bulkWrite`);
      return {};
    }),
    drop: vi.fn(async () => true),
    updateOne: vi.fn(async () => ({})),
  });
  class MongoClient {
    connect = vi.fn(async () => this);
    close = vi.fn(async () => undefined);
    db = () => ({ collection });
  }
  return { MongoClient };
});

import { handler } from './dataSyncerHandler';

const invoke = () => handler({ syncPreviewSettings: true }, {} as Context, () => undefined);

describe('dataSyncerHandler', () => {
  const env = { ...process.env };
  const fetchSpy = vi.fn();

  beforeEach(() => {
    inserted.clear();
    state.marker = null;
    state.failInsertInto = undefined;
    state.ops = [];
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.STAGING_MONGODB_URI = 'mongodb://staging/db';
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
});
