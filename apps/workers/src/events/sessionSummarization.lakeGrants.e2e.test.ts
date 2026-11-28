import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import {
  DataLakeModel,
  DataLakeAccessGrantModel,
  FabFile,
  Session,
  Quest,
  User,
  dataLakeAccessGrantRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const external = vi.hoisted(() => ({ upload: vi.fn(async () => undefined) }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    fabFilesService: { ...actual.fabFilesService, updateFabFile: vi.fn(actual.fabFilesService.updateFabFile) },
  };
});
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  SessionEvents: {
    Summarize: { schema: { parse: (properties: unknown) => properties } },
    Tag: { publish: vi.fn() },
  },
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'gpt-4o-mini',
      modelInfo: { name: 'Fixture model', backend: 'test' },
      llm: {
        complete: async (
          _modelId: string,
          _messages: unknown,
          _options: unknown,
          onChunk: (chunk: string[]) => Promise<void>
        ) => onChunk(['A newly generated summary.']),
      },
    }),
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({
    upload: external.upload,
    getSignedUrl: vi.fn(async () => 'https://storage.example.test/summary'),
  }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: vi.fn() }));
vi.mock('@workers/events/sessionOperationalCreditGate', () => ({
  payerCanFundSessionOperation: vi.fn(async () => true),
}));

import { handler } from './sessionSummarization';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const creatorId = new mongoose.Types.ObjectId().toString();
const newOwnerId = new mongoose.Types.ObjectId().toString();
const summary = 'A newly generated summary.';

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.create([
    { _id: creatorId, username: 'creator', email: 'creator@example.test', name: 'Creator' },
    { _id: newOwnerId, username: 'new-owner', email: 'owner@example.test', name: 'Owner' },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    [Session, Quest, FabFile, DataLakeModel, DataLakeAccessGrantModel].map(model => model.collection.deleteMany({}))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

const fixture = async (ownerId: string, creatorIsCurator = false) => {
  const session = await Session.create({
    name: 'Worker summary',
    userId: creatorId,
    firstCreated: new Date(),
    lastUpdated: new Date(),
    tags: [{ name: 'worker-notes:new', strength: 9 }],
  });
  await Quest.create({ sessionId: session.id, timestamp: new Date(), type: 'chat', prompt: 'Describe pulsars.' });
  const file = await FabFile.create({
    userId: creatorId,
    sessionId: session.id,
    fileName: 'Existing summary.txt',
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    type: KnowledgeType.FILE,
    filePath: 'existing-summary.txt',
    fileSize: 3,
    status: 'complete',
    storageChargedAt: new Date(),
    tags: [{ name: 'unrelated', strength: 1 }],
  });
  const lake = await DataLakeModel.create({
    name: 'Worker notes',
    slug: 'worker-notes',
    fileTagPrefix: 'worker-notes:',
    datalakeTag: 'datalake:worker-notes',
    createdByUserId: creatorId,
    status: 'active',
  });
  await dataLakeAccessGrantRepository.upsertGrant({
    dataLakeId: lake.id,
    principalType: 'user',
    principalId: ownerId,
    role: 'owner',
    grantedByUserId: creatorId,
  });
  if (creatorIsCurator) {
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id,
      principalType: 'user',
      principalId: creatorId,
      role: 'curator',
      grantedByUserId: ownerId,
    });
  }
  return { session, file, lake };
};

const summarize = async (sessionId: string) =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { properties: { sessionId, userId: creatorId, trigger: 'manual' } },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() }
  );

const expectPrimarySummary = async (sessionId: string) => {
  const saved = await Session.findById(sessionId);
  expect(saved?.summary).toBe(summary);
  expect(saved?.summaryModelId).toBe('gpt-4o-mini');
  expect(saved?.summaryAt).toBeInstanceOf(Date);
  expect(saved?.summaryTrigger).toBe('manual');
};

describe('summary worker uses live lake grants for existing summary files', () => {
  it('refuses a new join by a creator whose manage grants were revoked after transfer', async () => {
    const { session, file, lake } = await fixture(newOwnerId);
    await expect(summarize(session.id)).rejects.toBeInstanceOf(BadRequestError);
    await expectPrimarySummary(session.id);
    const savedFile = await FabFile.findById(file.id);
    expect(savedFile?.tags).toEqual([{ name: 'unrelated', strength: 1 }]);
    expect(savedFile?.fileSize).toBe(3);
    expect((await DataLakeModel.findById(lake.id))?.fileCount).toBe(0);
    expect(external.upload).not.toHaveBeenCalled();
  });

  it.each([
    { description: 'current owner', ownerId: creatorId, curator: false },
    { description: 'retained curator after transfer', ownerId: newOwnerId, curator: true },
  ])('allows the creator as $description', async ({ ownerId, curator }) => {
    const { session, file, lake } = await fixture(ownerId, curator);
    const update = vi.mocked(fabFilesService.updateFabFile);
    const activeGrants = vi.spyOn(dataLakeAccessGrantRepository, 'listActiveByLakes');
    await summarize(session.id);
    await expectPrimarySummary(session.id);
    const savedFile = await FabFile.findById(file.id);
    expect(savedFile?.tags).toEqual(expect.arrayContaining([{ name: 'worker-notes:new', strength: 9 }]));
    expect(savedFile?.fileSize).toBe(Buffer.byteLength(summary));
    expect((await DataLakeModel.findById(lake.id))?.fileCount).toBe(1);
    expect(external.upload).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[2].db.dataLakeAccessGrants).toBe(dataLakeAccessGrantRepository);
    expect(activeGrants).toHaveBeenCalledWith(expect.arrayContaining([lake.id]), { activeAsOf: expect.any(Date) });
  });
});
