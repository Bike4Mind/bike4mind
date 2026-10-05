import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { ISessionDocument, SessionListFilters } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionListFilterQuery, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const OWNER = 'owner-1';
let minute = 0;

const insertSession = async (name: string, fields: Record<string, unknown> = {}) => {
  minute += 1;
  return Session.create({
    name,
    userId: OWNER,
    lastUpdated: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    firstCreated: new Date(),
    ...fields,
  });
};

const list = async (filters?: SessionListFilters) => {
  const { data } = await sessionRepository.searchByUserId(
    undefined,
    OWNER,
    {
      pagination: { page: 1, limit: 50 },
      orderBy: { field: 'lastUpdated' as keyof ISessionDocument, direction: 'desc' },
    },
    undefined,
    filters
  );
  return data.map(session => session.name).sort();
};

const rawDoc = async (id: string) => Session.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('Session.origin', () => {
  it('persists channel and apiKeyId at creation', async () => {
    const session = await insertSession('api', { origin: { channel: 'api', apiKeyId: 'key-1' } });
    expect((await rawDoc(session.id))?.origin).toEqual({ channel: 'api', apiKeyId: 'key-1' });
  });

  it('rejects an unknown channel', async () => {
    await expect(insertSession('bad', { origin: { channel: 'fax' } })).rejects.toThrow();
  });

  it('is immutable through sessionRepository.update', async () => {
    const session = await insertSession('api', { origin: { channel: 'api', apiKeyId: 'key-1' } });
    await sessionRepository.update({ id: session.id, name: 'renamed', origin: { channel: 'web' } });
    const stored = await rawDoc(session.id);
    expect(stored?.name).toBe('renamed');
    expect(stored?.origin).toEqual({ channel: 'api', apiKeyId: 'key-1' });
  });
});

describe('Session.imageCount', () => {
  it('reads back 0 by default', async () => {
    const session = await insertSession('plain');
    expect(session.imageCount).toBe(0);
  });

  it('increments atomically, including on a row that predates the field', async () => {
    const session = await insertSession('legacy');
    await Session.collection.updateOne({ _id: session._id }, { $unset: { imageCount: '' } });

    await Promise.all([
      sessionRepository.incrementImageCount(session.id, 2),
      sessionRepository.incrementImageCount(session.id, 1),
    ]);

    expect((await rawDoc(session.id))?.imageCount).toBe(3);
  });

  it('ignores a non-positive count and a malformed id', async () => {
    const session = await insertSession('plain');
    await sessionRepository.incrementImageCount(session.id, 0);
    await expect(sessionRepository.incrementImageCount('not-an-id', 1)).resolves.toBeUndefined();
    expect((await rawDoc(session.id))?.imageCount).toBe(0);
  });
});

describe('sessionRepository.searchByUserId origin and image filters', () => {
  const seed = async () => {
    await insertSession('web', { origin: { channel: 'web' } });
    await insertSession('legacy');
    await insertSession('api-images', { origin: { channel: 'api', apiKeyId: 'key-1' }, imageCount: 2 });
    await insertSession('api-chat', { origin: { channel: 'api', apiKeyId: 'key-1' } });
    await insertSession('slack', { origin: { channel: 'slack' } });
    await insertSession('web-images', { origin: { channel: 'web' }, imageCount: 1 });
    // A legacy row whose imageCount was never written must count as "no images".
    const noCount = await insertSession('legacy-no-count');
    await Session.collection.updateOne({ _id: noCount._id }, { $unset: { imageCount: '' } });
  };

  it('returns everything with no filters (default list unchanged)', async () => {
    await seed();
    expect(await list()).toEqual(
      ['api-chat', 'api-images', 'legacy', 'legacy-no-count', 'slack', 'web', 'web-images'].sort()
    );
  });

  it('origin=api returns only API sessions', async () => {
    await seed();
    expect(await list({ origin: 'api' })).toEqual(['api-chat', 'api-images']);
  });

  it('excludeOrigin=api keeps legacy sessions with no origin', async () => {
    await seed();
    expect(await list({ excludeOrigin: 'api' })).toEqual(
      ['legacy', 'legacy-no-count', 'slack', 'web', 'web-images'].sort()
    );
  });

  it('origin=web also matches sessions with no recorded origin', async () => {
    await seed();
    expect(await list({ origin: 'web' })).toEqual(['legacy', 'legacy-no-count', 'web', 'web-images'].sort());
  });

  it('hasImages filters both ways and combines with origin', async () => {
    await seed();
    expect(await list({ hasImages: true })).toEqual(['api-images', 'web-images']);
    expect(await list({ hasImages: false })).toEqual(['api-chat', 'legacy', 'legacy-no-count', 'slack', 'web'].sort());
    expect(await list({ hasImages: true, excludeOrigin: 'api' })).toEqual(['web-images']);
  });

  it('keeps pagination correct under a filter', async () => {
    await seed();
    const page = (n: number) =>
      sessionRepository.searchByUserId(
        undefined,
        OWNER,
        {
          pagination: { page: n, limit: 2 },
          orderBy: { field: 'lastUpdated' as keyof ISessionDocument, direction: 'desc' },
        },
        undefined,
        { excludeOrigin: 'api' }
      );
    const first = await page(1);
    const second = await page(2);
    const third = await page(3);
    expect(first.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    const names = [...first.data, ...second.data, ...third.data].map(session => session.name);
    expect(names).toEqual(['legacy-no-count', 'web-images', 'slack', 'legacy', 'web']);
  });
});

describe('sessionListFilterQuery', () => {
  it('is empty with no filters, so the default list query is unchanged', () => {
    expect(sessionListFilterQuery()).toEqual({});
    expect(sessionListFilterQuery({})).toEqual({});
  });

  it('builds an $in over the remaining channels, adding null when web remains', () => {
    expect(sessionListFilterQuery({ origin: 'api' })).toEqual({ 'origin.channel': { $in: ['api'] } });
    expect(sessionListFilterQuery({ excludeOrigin: 'api' })).toEqual({
      'origin.channel': { $in: ['web', 'slack', 'cli', 'agent', null] },
    });
  });
});
