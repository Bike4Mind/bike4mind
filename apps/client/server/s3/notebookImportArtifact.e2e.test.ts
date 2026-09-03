import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Artifact, ArtifactContent, ArtifactVersion, Session } from '@bike4mind/database';
import { notebookImportService } from '@bike4mind/services';
import { createArtifactWrites, createChatHistoryWrites, createSessionWrites } from './notebookImportComplete';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the REAL service through the REAL three models, because a payload that drifts from the
 * artifact schema is what made every import fail while reporting success - and both sibling e2e
 * files stub `createArtifact` out and never set `importArtifacts`, so neither can see it.
 *
 * Run `pnpm --filter @bike4mind/services build` first: the service comes from the built dist, so a
 * stale build reports green against whatever was last compiled.
 *
 * No transaction here - createMongoServer is a standalone mongod, and transactions need a replica
 * set. What breaks in this layer is the payload against the schema, which a standalone reproduces.
 */

const { NotebookImportService } = notebookImportService;

let mongoServer: MongoMemoryServer;
const USER = 'artifact-import-owner';

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([
    Artifact.deleteMany({}, { hardDelete: true }),
    ArtifactContent.deleteMany({}, { hardDelete: true }),
    ArtifactVersion.deleteMany({}, { hardDelete: true }),
    Session.deleteMany({}, { hardDelete: true }),
  ]);
});

const BODY = '<svg><circle r="4" /></svg>';

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact_1_abc',
    name: 'My Diagram',
    type: 'svg',
    content: BODY,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    metadata: { source: 'export' },
    ...overrides,
  };
}

function payload(artifacts: Record<string, unknown>[]) {
  return {
    exportVersion: '1.0.0',
    notebooks: [
      {
        id: 'nb-1',
        name: 'Notebook With Artifacts',
        firstCreated: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-02T00:00:00.000Z',
        chatHistory: [],
        knowledge: [],
        artifacts,
        tools: [],
        agents: [],
      },
    ],
  };
}

function makeService() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const adapters = {
    sessionRepository: createSessionWrites(),
    chatHistoryRepository: createChatHistoryWrites(),
    knowledgeRepository: { create: async () => null },
    // the real thing, not a copy
    ...createArtifactWrites(undefined, logger as never),
    toolRepository: { create: async () => null, find: async () => [], findById: async () => null },
    agentRepository: { create: async () => null },
    userRepository: { findById: async () => ({ id: USER }) },
    fileStorageService: {
      uploadFile: async () => null,
      getFileContent: async () => null,
      getSignedUrl: async () => '',
    },
    logger,
    generateId: () => `artifact_gen_${Math.random().toString(36).slice(2, 10)}`,
  };
  return new NotebookImportService(adapters as never);
}

const OPTIONS = {
  conflictResolution: 'rename',
  importKnowledge: false,
  importArtifacts: true,
  importTools: false,
  importAgents: false,
};

async function runImport(artifacts: Record<string, unknown>[], options: Record<string, unknown> = {}) {
  return makeService().importNotebooks(USER, payload(artifacts) as never, { ...OPTIONS, ...options } as never);
}

describe('notebook import: artifacts against real models', () => {
  it('writes the three linked documents, private to the importer, with the notebook pointing at them', async () => {
    const result = await runImport([artifact()]);

    expect(result.importedAttachments).toBe(1);
    expect(result.warnings ?? []).toEqual([]);

    const written = await Artifact.findOne({ userId: USER });
    const content = await ArtifactContent.findOne({});
    const version = await ArtifactVersion.findOne({});

    // The link is the part a re-implementation cannot check: the artifact points at the content row
    // it was built from, and the version row points at the same one.
    expect(written).not.toBeNull();
    expect(content?.content).toBe(BODY);
    expect(String(written?.contentId)).toBe(String(content?._id));
    expect(String(version?.contentId)).toBe(String(content?._id));
    expect(content?.artifactId).toBe(written?.id);
    expect(content?.version).toBe(written?.version);

    // Derived from the body rather than carried by the export, which is why the body had to be
    // exported at all.
    expect(written?.contentHash).toBe(content?.contentHash);
    expect(written?.contentSize).toBe(BODY.length);

    // The export calls it `name`, and an artifact nothing points at is unreachable.
    expect(written?.title).toBe('My Diagram');
    expect((await Session.findOne({ userId: USER }))?.artifactIds).toEqual([written?.id]);

    // An import must not publish on the importer's behalf, whatever the source artifact was.
    expect(written?.visibility).toBe('private');
    expect(written?.permissions?.isPublic).toBe(false);
    expect(written?.permissions?.canRead).toEqual([USER]);
    expect(written?.userId).toBe(USER);
  });

  it('refuses a preserved id that is already taken instead of writing a duplicate key', async () => {
    // Re-importing an export into the account it came from. Left to the write this is a server-side
    // duplicate key, which aborts the transaction the real import runs inside.
    await runImport([artifact()], { preserveIds: true });
    const result = await runImport([artifact()], { preserveIds: true });

    expect(result.importedAttachments).toBe(0);
    expect((result.warnings ?? []).join(' ')).toContain('artifact_1_abc');
    expect(await Artifact.countDocuments({ id: 'artifact_1_abc' })).toBe(1);
    expect(await ArtifactContent.countDocuments({})).toBe(1);
  });

  it('writes nothing for a bodyless artifact, since the schema cannot describe one', async () => {
    const result = await runImport([artifact({ content: undefined })]);

    expect(result.importedAttachments).toBe(0);
    expect(await Artifact.countDocuments({})).toBe(0);
    expect(await ArtifactContent.countDocuments({})).toBe(0);
    expect(await ArtifactVersion.countDocuments({})).toBe(0);
  });
});
