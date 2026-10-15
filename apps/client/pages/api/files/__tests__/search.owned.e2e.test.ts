import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
import { GENERATED_ASSET_GENERATOR_TAG, GENERATED_ASSET_TAG, KnowledgeType } from '@bike4mind/common';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FabFile } from '@bike4mind/database';

/**
 * The `owned` filter end to end against a real FabFile collection. Studio's Recent speech list sends it, and the
 * hazard is silent: if the route kept the default-view scope, files shared through a group, a personal share or a
 * data lake would join the caller's own history with no error anywhere.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (handler: (req: unknown, res: unknown) => Promise<unknown>) => {
      mockRefs.getHandler = handler;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ getSignedUrl: async () => 'https://objects.example.invalid/file' }),
}));

import '@pages/api/files/search';

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const GROUP = 'group-a';
// `Opti` grants the registry's only data lake, whose files reach the default view by tag alone.
const USER = { id: OWNER, groups: [GROUP], tags: ['Opti'] };
const LAKE_TAG = 'datalake:opti-knowledge';
const SPEECH_TAG = GENERATED_ASSET_GENERATOR_TAG.speech;

const listSpeech = async (owned?: boolean) => {
  const { req, res } = createMocks({
    method: 'GET',
    url: '/api/files/search',
    query: {
      filters: {
        generated: 'true',
        tags: [SPEECH_TAG],
        ...(owned === undefined ? {} : { owned: String(owned) }),
      },
      order: { by: 'fileName', direction: 'asc' },
    },
  });
  Object.assign(req, { user: USER, ability: { can: () => true }, logger: { error: vi.fn() } });
  await mockRefs.getHandler!(req, res);
  const body = res._getJSONData() as { data: Array<{ fileName: string }> };
  return body.data.map(file => file.fileName);
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const read = ['read'];
  await FabFile.create(
    [
      { fileName: 'mine', userId: OWNER, tags: [] },
      { fileName: 'group-shared', userId: OTHER, tags: [], groups: [{ groupId: GROUP, permissions: read }] },
      { fileName: 'personally-shared', userId: OTHER, tags: [], users: [{ userId: OWNER, permissions: read }] },
      { fileName: 'lake-shared', userId: OTHER, tags: [LAKE_TAG] },
    ].map(({ tags, ...file }) => ({
      ...file,
      type: KnowledgeType.FILE,
      tags: [GENERATED_ASSET_TAG, SPEECH_TAG, ...tags].map(name => ({ name, strength: 1 })),
    }))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('GET /api/files/search owned filter (real Mongo)', () => {
  // Proves the fixtures really are visible through sharing, so the owned case below is not vacuous.
  it('the default view admits generated files shared with the caller', async () => {
    await expect(listSpeech()).resolves.toEqual(['group-shared', 'lake-shared', 'mine', 'personally-shared']);
  });

  it('owned keeps the caller own generated file and excludes every shared one', async () => {
    await expect(listSpeech(true)).resolves.toEqual(['mine']);
  });

  it('owned=false is the default view, not owner-only', async () => {
    await expect(listSpeech(false)).resolves.toHaveLength(4);
  });
});
