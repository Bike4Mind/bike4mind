import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
import { FabFileSourceType, KnowledgeType, type GeneratedAssetLineageEntry } from '@bike4mind/common';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, User } from '@bike4mind/database';
import type { FileLineage } from '@server/files/fileLineage';
import { LINEAGE_MAX_DEPTH } from '@server/files/fileLineage';

/**
 * The lineage route end to end against a real FabFile collection: the per-file ACL decides which ancestors
 * come back readable, and the children lookup runs the real `derivedFrom.fileId` query.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    // The rate limiter comes first; the route handler is the last argument.
    get: (...handlers: Array<(req: unknown, res: unknown) => Promise<unknown>>) => {
      mockRefs.getHandler = handlers.at(-1)!;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({ requireStudioFeature: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: async () => 'https://objects.example.invalid/file' }),
}));
// Lake-granted reads are loadAccessibleFabFile's and listFilesByIds's own concern; here only the per-file ACL decides.
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ holdsDataLakeReadScope: () => false }));

import '@pages/api/studio/files/[id]/lineage';

const OTHER = new mongoose.Types.ObjectId().toString();
let caller: { id: string; groups: string[] };

const createGenerated = async (
  fileName: string,
  { userId = caller.id, derivedFrom }: { userId?: string; derivedFrom?: GeneratedAssetLineageEntry[] } = {}
) => {
  const file = await FabFile.create({
    fileName,
    userId,
    type: KnowledgeType.FILE,
    mimeType: 'image/png',
    moderationStatus: 'clean',
    filePath: `generated/${fileName}.png`,
    sourceType: FabFileSourceType.TOOL_GENERATED,
    sourceMetadata: {
      generation: { generator: 'image', provider: 'test', modelId: 'model-x', prompt: fileName, request: { fileName } },
    },
    ...(derivedFrom && { derivedFrom }),
  });
  return String(file._id);
};

const getLineage = async (id: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, {
    user: { ...caller, _id: caller.id },
    ability: { can: () => true },
    logger: { error: vi.fn(), updateMetadata: vi.fn() },
  });
  await mockRefs.getHandler!(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as FileLineage };
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await FabFile.syncIndexes();
  const user = await User.create({ username: 'trail-user', name: 'Trail User', email: 'trail-user@example.com' });
  caller = { id: String(user._id), groups: [] };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('GET /api/studio/files/:id/lineage (real Mongo)', () => {
  it('returns readable ancestors with their stored request and role-labelled edges', async () => {
    const reference = await createGenerated('reference');
    const take = await createGenerated('take', { derivedFrom: [{ fileId: reference, role: 'reference' }] });

    const { status, body } = await getLineage(take);

    expect(status).toBe(200);
    expect(body.ancestors.map(node => node.fileId)).toEqual([take, reference]);
    expect(body.ancestors[1]).toMatchObject({
      redacted: false,
      depth: 1,
      generator: 'image',
      modelId: 'model-x',
      request: { fileName: 'reference' },
      url: expect.any(String),
    });
    expect(body.edges).toEqual([{ parentId: reference, childId: take, role: 'reference' }]);
    expect(body.truncated).toBe(false);
  });

  it('redacts an ancestor the caller cannot read and never walks past it', async () => {
    const hiddenGrandparent = await createGenerated('hidden-grandparent', { userId: OTHER });
    const hiddenParent = await createGenerated('hidden-parent', {
      userId: OTHER,
      derivedFrom: [{ fileId: hiddenGrandparent, role: 'style' }],
    });
    const take = await createGenerated('take-of-hidden', {
      derivedFrom: [{ fileId: hiddenParent, role: 'edit_source' }],
    });

    const { body } = await getLineage(take);

    expect(body.ancestors).toEqual([
      expect.objectContaining({ fileId: take, redacted: false }),
      { fileId: hiddenParent, depth: 1, redacted: true },
    ]);
    expect(JSON.stringify(body)).not.toContain('hidden-parent');
    expect(JSON.stringify(body)).not.toContain(hiddenGrandparent);
  });

  it('stops at the depth bound and flags the trail as truncated', async () => {
    let parent = await createGenerated('chain-0');
    for (let generation = 1; generation <= LINEAGE_MAX_DEPTH + 2; generation++) {
      parent = await createGenerated(`chain-${generation}`, {
        derivedFrom: [{ fileId: parent, role: 'variation_of' }],
      });
    }

    const { body } = await getLineage(parent);

    expect(body.ancestors).toHaveLength(LINEAGE_MAX_DEPTH + 1);
    expect(Math.max(...body.ancestors.map(node => node.depth))).toBe(LINEAGE_MAX_DEPTH);
    expect(body.truncated).toBe(true);
  });

  it('lists readable direct children newest first and drops deleted, archived and unreadable ones', async () => {
    const source = await createGenerated('source');
    const older = await createGenerated('older-child', { derivedFrom: [{ fileId: source, role: 'first_frame' }] });
    const newer = await createGenerated('newer-child', { derivedFrom: [{ fileId: source, role: 'variation_of' }] });
    await createGenerated('someone-elses-child', {
      userId: OTHER,
      derivedFrom: [{ fileId: source, role: 'reference' }],
    });
    const deleted = await createGenerated('deleted-child', { derivedFrom: [{ fileId: source, role: 'reference' }] });
    await FabFile.updateOne({ _id: deleted }, { $set: { deletedAt: new Date() } });
    const archived = await createGenerated('archived-child', { derivedFrom: [{ fileId: source, role: 'reference' }] });
    await FabFile.updateOne({ _id: archived }, { $set: { archivedAt: new Date() } });

    const { body } = await getLineage(source);

    expect(body.children.map(node => node.fileId)).toEqual([newer, older]);
    expect(body.children.every(node => node.depth === -1)).toBe(true);
    expect(body.edges).toEqual(
      expect.arrayContaining([
        { parentId: source, childId: newer, role: 'variation_of' },
        { parentId: source, childId: older, role: 'first_frame' },
      ])
    );
  });

  it('answers 404 for a file the caller cannot read', async () => {
    const hidden = await createGenerated('not-mine', { userId: OTHER });
    await expect(getLineage(hidden)).rejects.toThrow('Fabfile not found');
  });
});
