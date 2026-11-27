import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@bike4mind/database', async () => {
  const { default: real } = await import('mongoose');
  return {
    mongoose: {
      Types: real.Types,
      connection: {
        get db() {
          return state.db;
        },
      },
      model: (name: string) => ({ collection: { name: `${name}-collection` } }),
    },
  };
});

import { accountArchiveAdapters } from './accountDataExportCollections';

const userId = '665f1c2e8b3a4d0012345678';
const adapter = accountArchiveAdapters.find(candidate => candidate.name === 'DelegatedItem')!;

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
}

describe('account archive adapters', () => {
  beforeEach(() => {
    state.db = undefined;
  });

  it('refuses to collect without a connected database', async () => {
    await expect(adapter.collect(userId, [])).rejects.toThrow(/connected database/);
  });

  it('streams id and timestamps of each owned row and closes the cursor', async () => {
    const rows = [
      { _id: 'a', createdAt: 1, updatedAt: 2 },
      { _id: 'b', createdAt: 3, updatedAt: 4 },
    ];
    const close = vi.fn();
    const find = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield* rows;
      },
      close,
    }));
    const collection = vi.fn(() => ({ find }));
    state.db = { collection };

    const { records, count } = await adapter.collect(userId, ['personal-org']);
    const lines = (await drain(records))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    expect(collection).toHaveBeenCalledWith('DelegatedItem-collection');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ $or: expect.any(Array) }), {
      projection: { _id: 1, createdAt: 1, updatedAt: 1 },
    });
    expect(lines).toEqual([
      { id: 'a', createdAt: 1, updatedAt: 2 },
      { id: 'b', createdAt: 3, updatedAt: 4 },
    ]);
    expect(count()).toBe(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
