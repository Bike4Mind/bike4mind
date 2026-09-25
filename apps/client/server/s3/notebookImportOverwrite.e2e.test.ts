import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest, Session, sessionRepository } from '@bike4mind/database';
import { notebookImportService } from '@bike4mind/services';
import { determineSessionOperations } from '@server/events/spider';
import { createChatHistoryWrites, createSessionWrites } from './notebookImportComplete';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Guards the invariant this handler exists for: importing an export NEVER rewrites messages that
 * already exist. The store used to upsert on the incoming id, so re-importing an export into the
 * database it came from matched the original documents and re-pointed them at the new notebook -
 * the source notebook was emptied and the import reported success.
 *
 * Drives the REAL service through the REAL write adapters against a real database, because the
 * defect lived in the adapter, not in the service.
 *
 * Run `pnpm --filter @bike4mind/services build` (or `pnpm turbo:core:build`) first. This imports
 * the service from the built dist, not from src, so a stale dist reports green against whatever
 * was last compiled - on exactly the service this file exists to guard. CI builds core fresh, so
 * the hazard is local only.
 */

const { NotebookImportService } = notebookImportService;

let mongoServer: MongoMemoryServer;

const USER = 'import-owner';

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([Quest.deleteMany({}, { hardDelete: true }), Session.deleteMany({}, { hardDelete: true })]);
});

/** Seeds a notebook with `count` messages and returns it with the ids the export would carry. */
async function seedNotebook(name: string, count: number, metadata: Record<string, unknown> = {}) {
  const session = await sessionRepository.create({
    userId: USER,
    name,
    firstCreated: new Date('2026-01-01T00:00:00Z'),
    lastUpdated: new Date('2026-01-02T00:00:00Z'),
    ...metadata,
  } as never);
  const sessionId = String((session as { id: string }).id);
  const docs = Array.from({ length: count }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)),
    type: 'message',
    prompt: `original ${i}`,
    reply: `reply ${i}`,
    status: 'done',
    pinned: false,
  }));
  await Quest.collection.insertMany(docs);
  return { sessionId, ids: docs.map(d => String(d._id)) };
}

function exportPayload(name: string, ids: string[], metadata: Record<string, unknown> = {}) {
  return {
    exportVersion: '1.0.0',
    notebooks: [
      {
        id: 'exported-notebook',
        name,
        firstCreated: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-02T00:00:00.000Z',
        chatHistory: ids.map((id, i) => ({
          id,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          type: 'message',
          prompt: `original ${i}`,
          reply: `reply ${i}`,
          status: 'done',
          pinned: false,
        })),
        knowledge: [],
        artifacts: [],
        tools: [],
        agents: [],
        ...metadata,
      },
    ],
  };
}

/**
 * `attachmentAdapters` overrides the four attachment write fakes, which otherwise return `null` -
 * fine for tests that never import an attachment, but `takeStoreId` throws on it for one that does.
 */
function makeService(attachmentAdapters: Partial<Record<string, unknown>> = {}) {
  const adapters = {
    // The real adapter, not a copy: re-implementing it here is what let `update` regress to `_id`
    // - the test kept passing because it was exercising its own copy, not the handler's.
    sessionRepository: createSessionWrites(),
    // the real thing, not a copy
    chatHistoryRepository: createChatHistoryWrites(),
    knowledgeRepository: { create: async () => null },
    artifactIdTaken: async () => false,
    createArtifact: async () => null,
    toolRepository: { create: async () => null, find: async () => [], findById: async () => null },
    agentRepository: { create: async () => null },
    userRepository: { findById: async () => ({ id: USER }) },
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    fileStorageService: {
      getFileContent: async () => null,
      uploadFile: async () => {},
      deleteFile: async () => null,
      getSignedUrl: async () => null,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    generateId: () => new mongoose.Types.ObjectId().toString(),
    ...attachmentAdapters,
  };
  return new NotebookImportService(adapters as never);
}

const OPTIONS = {
  importKnowledge: false,
  importArtifacts: false,
  importTools: false,
  importAgents: false,
};

describe('notebook import does not overwrite existing messages', () => {
  it('leaves the source notebook intact when its own export is re-imported', async () => {
    const { sessionId, ids } = await seedNotebook('Shared Name', 5);
    const payload = exportPayload('Different Name', ids);

    const result = await makeService().importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'rename',
        preserveIds: true,
      } as never
    );

    // The ids already exist, so the import must refuse rather than claim them.
    expect(result.errors?.length).toBe(1);
    expect(String(result.errors?.[0])).toMatch(/duplicate key/i);

    // The invariant. Before the fix these were 0 and 5: the messages were moved, not copied.
    // Nothing partial lands: bulkWrite is ordered and every id collides on the first op.
    expect(await Quest.countDocuments({ sessionId })).toBe(5);
    expect(await Quest.countDocuments({})).toBe(5);
  });

  it('copies messages into a new notebook rather than moving them', async () => {
    const { sessionId, ids } = await seedNotebook('Shared Name', 5);
    const payload = exportPayload('Different Name', ids);

    await makeService().importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'rename',
        preserveIds: false,
      } as never
    );

    expect(await Quest.countDocuments({ sessionId })).toBe(5);
    // 5 originals + 5 copies; a move would leave the total at 5.
    expect(await Quest.countDocuments({})).toBe(10);
  });

  it('replaces rather than collides when overwriting an existing notebook', async () => {
    const { sessionId, ids } = await seedNotebook('Shared Name', 5);
    const payload = exportPayload('Shared Name', ids);

    const result = await makeService().importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'overwrite',
        preserveIds: true,
      } as never
    );

    // The old rows are hard-deleted first; a soft delete would leave their ids to collide with.
    expect(result.errors).toEqual([]);
    expect(await Quest.countDocuments({ sessionId })).toBe(5);
    expect(await Quest.countDocuments({})).toBe(5);
  });

  it('updates the existing notebook metadata when overwriting', async () => {
    const { sessionId, ids } = await seedNotebook('Same Name', 2);
    const payload = exportPayload('Same Name', ids);
    payload.notebooks[0].lastUpdated = '2027-03-04T05:06:07.000Z';

    const result = await makeService().importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'overwrite',
        preserveIds: true,
      } as never
    );

    // The metadata write goes through the real repository; passing the wrong identity field made
    // it throw and took the whole import with it.
    expect(result.errors).toEqual([]);
    const after = await Session.findById(sessionId);
    expect(after?.lastUpdated?.toISOString()).toBe('2027-03-04T05:06:07.000Z');
  });

  it('imports a message whose prompt is empty, as the exporter emits', async () => {
    const { ids } = await seedNotebook('Shared Name', 2);
    const payload = exportPayload('Different Name', ids);
    payload.notebooks[0].chatHistory[0].prompt = '';

    const result = await makeService().importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'rename',
        preserveIds: false,
      } as never
    );

    expect(result.errors).toEqual([]);
    expect(await Quest.countDocuments({ prompt: '' })).toBe(1);
  });
});

/** The document as later readers see it: through the repository, as a plain object. */
async function reload(sessionId: string) {
  const [stored] = await sessionRepository.find({ _id: sessionId } as never);
  return stored as unknown as {
    tags?: unknown[];
    taggedAt?: Date | null;
    knowledgeIds?: string[];
    artifactIds?: string[];
    toolIds?: string[];
    agentIds?: string[];
  };
}

/**
 * `tags` and `taggedAt` have to move together: `spider.ts` re-tags only when `!session.taggedAt`,
 * so a target left with a stamp but no tags is never tagged again. The overwrite payload used to
 * carry `undefined` for a value the file lacked, and mongoose deletes every `undefined` from the
 * `$set` - so the target's stale stamp survived a write that otherwise looked correct. This drives
 * the real service through the real write adapters against a real mongod.
 */
describe('notebook import overwrite keeps tags and their stamp together', () => {
  it('leaves a tagged notebook re-taggable when the file carries no tags', async () => {
    const { sessionId, ids } = await seedNotebook('Same Name', 2, {
      tags: [{ name: 'stale', strength: 5 }],
      taggedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await makeService().importNotebooks(
      USER,
      exportPayload('Same Name', ids) as never,
      { ...OPTIONS, conflictResolution: 'overwrite', preserveIds: true } as never
    );

    expect(result.errors).toEqual([]);
    const after = await reload(sessionId);

    // The file carries no tags, so the target's tags are gone - and the stamp has to go with them.
    expect(after.tags).toEqual([]);
    expect(after.taggedAt ?? null).toBeNull();
    // Stated in the gate's own terms, because that is the consequence that matters: on its next
    // pass the spider still sees a notebook that needs tagging.
    expect(determineSessionOperations(after as never, ['tags']).tags).toBe(true);
  });

  it('keeps the file tags and the file stamp when the file carries both', async () => {
    const { sessionId, ids } = await seedNotebook('Same Name', 2, {
      tags: [{ name: 'stale', strength: 5 }],
      taggedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await makeService().importNotebooks(
      USER,
      exportPayload('Same Name', ids, {
        tags: [{ name: 'carried', strength: 9 }],
        taggedAt: '2026-05-06T07:08:09.000Z',
      }) as never,
      { ...OPTIONS, conflictResolution: 'overwrite', preserveIds: true } as never
    );

    expect(result.errors).toEqual([]);
    const after = await reload(sessionId);

    expect(after.tags).toEqual([{ name: 'carried', strength: 9 }]);
    expect(after.taggedAt?.toISOString()).toBe('2026-05-06T07:08:09.000Z');
    // Already tagged, so the spider must NOT spend a completion on it again.
    expect(determineSessionOperations(after as never, ['tags']).tags).toBe(false);
  });
});

/**
 * `handleExistingSession` used to return from the overwrite branch above the attachment-import
 * block, so an overwrite could never gain attachments - and even a fixed in-memory fold would be
 * unproven against the real session document `sessionRepository.find` hands back, which is where
 * the FoundNotebook widening this fix relies on actually gets exercised.
 *
 * The session repository (and chat history repository) are real, via `makeService` above - that is
 * the part under test. The four attachment stores passed in below are fakes standing in for
 * FabFile/Artifact/Tool/Agent, each returning one canned id.
 */
describe('notebook import overwrite unions attachment ids through the real session repository', () => {
  it('keeps the target pre-existing attachment ids and gains the newly imported ones', async () => {
    const { sessionId, ids } = await seedNotebook('Same Name', 1, {
      knowledgeIds: ['old-knowledge-id'],
      artifactIds: ['old-artifact-id'],
      toolIds: ['old-tool-id'],
      agentIds: ['old-agent-id'],
    });

    const payload = exportPayload('Same Name', ids, {
      knowledge: [
        { id: 'exported-knowledge-id', name: 'notes.txt', mimeType: 'text/plain', size: 5, content: 'aGVsbG8=' },
      ],
      artifacts: [
        {
          id: 'artifact_recharts_Q3-Revenue_1700000000000_0',
          name: 'My Chart',
          type: 'recharts',
          content: 'chart body',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      tools: [{ id: 'exported-tool-id', name: 'Tool One', createdAt: '2026-01-01T00:00:00.000Z' }],
      agents: [{ id: 'exported-agent-id', name: 'Agent One', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const service = makeService({
      knowledgeRepository: { create: async () => ({ id: 'store-knowledge-id' }) },
      createArtifact: async () => ({ id: 'store-artifact-id' }),
      toolRepository: {
        create: async () => ({ id: 'store-tool-id' }),
        find: async () => [],
        findById: async () => null,
      },
      agentRepository: { create: async () => ({ id: 'store-agent-id' }) },
    });

    const result = await service.importNotebooks(
      USER,
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'overwrite',
        preserveIds: true,
        importKnowledge: true,
        importArtifacts: true,
        importTools: true,
        importAgents: true,
      } as never
    );

    expect(result.errors).toEqual([]);
    expect(result.importedAttachments).toBe(4);

    const after = await reload(sessionId);
    expect(after.knowledgeIds).toEqual(['old-knowledge-id', 'store-knowledge-id']);
    expect(after.artifactIds).toEqual(['old-artifact-id', 'store-artifact-id']);
    expect(after.toolIds).toEqual(['old-tool-id', 'store-tool-id']);
    expect(after.agentIds).toEqual(['old-agent-id', 'store-agent-id']);
  });
});
