import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

// The Resource links only MONGODB_URI: the handler must not need a prod API key.
vi.mock('sst', () => ({ Resource: { MONGODB_URI: { value: 'mongodb://target/%STAGE%' } } }));

const inserted = vi.hoisted(() => new Map<string, number>());

vi.mock('mongodb', () => {
  const collection = (name: string) => ({
    findOne: vi.fn(async () => null),
    countDocuments: vi.fn(async () => 1),
    find: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { _id: `${name}-doc` };
      },
    })),
    insertMany: vi.fn(async (docs: unknown[]) => {
      inserted.set(name, (inserted.get(name) ?? 0) + docs.length);
      return { insertedCount: docs.length };
    }),
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
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

    await invoke();

    expect(inserted.size).toBe(0);
  });
});
