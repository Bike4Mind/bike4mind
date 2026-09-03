import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Artifact,
  ArtifactContent,
  ArtifactVersion,
  Session,
  artifactRepository,
  artifactContentRepository,
} from '@bike4mind/database';
import { notebookExportService, notebookImportService } from '@bike4mind/services';
import { createArtifactWrites, createSessionWrites } from './notebookImportComplete';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the REAL export against the REAL artifact repositories, because what this guards is a
 * MongoDB semantic the unit tests cannot see: they hand the service a stub that inspects the filter
 * object, so they prove the query was BUILT correctly and nothing about how it RESOLVES.
 *
 * Two of those semantics carry the fix:
 *   - `$in: []` matches no documents, so an empty `session.artifactIds` leaves the sessionId branch
 *     to decide rather than matching everything
 *   - the membership and access clauses are both `$or`s and must nest under `$and`; as two keys of
 *     one object literal the second would silently replace the first and the access check would be
 *     gone. A stub asserting on `query.$or` cannot tell those two shapes apart.
 *
 * Run `pnpm --filter @bike4mind/services build` first: the service comes from the built dist, so a
 * stale build reports green against whatever was last compiled.
 */

const { NotebookExportService } = notebookExportService;
const { NotebookImportService } = notebookImportService;

let mongoServer: MongoMemoryServer;
const USER = 'export-owner';
const SESSION_ID = '507f1f77bcf86cd799439011';
const BODY = '<svg><circle r="4" /></svg>';

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

/** Written through the collection, not the model: these rows only need to be queryable. */
async function seedArtifact(over: Record<string, unknown> = {}) {
  const id = (over.id as string) ?? 'artifact_chat_1';
  await Artifact.collection.insertOne({
    id,
    userId: USER,
    title: 'Red Circle',
    type: 'svg',
    version: 1,
    deletedAt: null,
    visibility: 'private',
    permissions: { canRead: [USER], canWrite: [USER], isPublic: false },
    ...over,
  });
  await ArtifactContent.collection.insertOne({ artifactId: id, version: 1, content: BODY });
  return id;
}

const SESSION = {
  id: SESSION_ID,
  _id: SESSION_ID,
  name: 'Notebook One',
  userId: USER,
  firstCreated: new Date('2026-01-01T00:00:00Z'),
  lastUpdated: new Date('2026-01-02T00:00:00Z'),
};

const OPTIONS = {
  format: 'json',
  includeArtifacts: true,
  includeKnowledge: false,
  includeTools: false,
  includeAgents: false,
  includeMetadata: true,
  maxFileSize: 1_000_000,
} as never;

/** Only the artifact side is real; everything else is the smallest stub the service will accept. */
async function exportOnce(sessionOver: Record<string, unknown> = {}) {
  const uploaded: string[] = [];
  const none = { find: vi.fn().mockResolvedValue([]) };
  const service = new NotebookExportService({
    sessionRepository: { find: vi.fn().mockResolvedValue([{ ...SESSION, ...sessionOver }]) },
    chatHistoryRepository: none,
    knowledgeRepository: { ...none, findOne: vi.fn().mockResolvedValue(null) },
    artifactRepository,
    artifactContentRepository,
    toolRepository: none,
    agentRepository: none,
    fileStorageService: {
      getFileContent: vi.fn().mockResolvedValue(null),
      uploadFile: vi.fn(async (_p: string, c: Buffer) => {
        uploaded.push(c.toString('utf-8'));
      }),
      getSignedUrl: vi.fn().mockResolvedValue('https://example.test/export.json'),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never);

  await service.exportNotebooks(USER, OPTIONS);
  return JSON.parse(uploaded[0]).notebooks[0];
}

describe('notebook export: artifacts against real models', () => {
  it('exports an artifact linked only by sessionId, with its body, when the notebook lists none', async () => {
    await seedArtifact({ id: 'artifact_chat_1', sessionId: SESSION_ID });

    // The ordinary case that used to export nothing: chat-created artifacts record their own
    // sessionId and are absent from session.artifactIds.
    const notebook = await exportOnce({ artifactIds: [] });

    expect(notebook.artifacts).toHaveLength(1);
    expect(notebook.artifacts[0]).toMatchObject({ id: 'artifact_chat_1', name: 'Red Circle', content: BODY });
  });

  it('still exports one named only in session.artifactIds, and does not duplicate an artifact in both', async () => {
    await seedArtifact({ id: 'artifact_listed' });
    await seedArtifact({ id: 'artifact_both', sessionId: SESSION_ID });

    const notebook = await exportOnce({ artifactIds: ['artifact_listed', 'artifact_both'] });

    expect(notebook.artifacts.map((a: { id: string }) => a.id).sort()).toEqual(['artifact_both', 'artifact_listed']);
  });

  it('refuses an artifact in the notebook that the exporter cannot read', async () => {
    // A collaborator's artifact carries this session's id; matching on sessionId must not become a
    // way around the access check that the id branch has always been subject to.
    await seedArtifact({
      id: 'artifact_theirs',
      sessionId: SESSION_ID,
      userId: 'someone-else',
      permissions: { canRead: ['someone-else'], canWrite: ['someone-else'], isPublic: false },
    });

    const notebook = await exportOnce({ artifactIds: [] });

    expect(notebook.artifacts).toEqual([]);
  });

  it('leaves out an artifact belonging to a different notebook', async () => {
    // Proves the membership clause survives: with the two $or clauses flattened into one object
    // the access clause would win alone and this row would export.
    await seedArtifact({ id: 'artifact_elsewhere', sessionId: 'other-session' });

    const notebook = await exportOnce({ artifactIds: [] });

    expect(notebook.artifacts).toEqual([]);
  });
});

/**
 * The two halves have to agree, and only a round trip shows it. Export could carry every artifact
 * correctly and the import still land them unreachable: an artifact resolves into a notebook by
 * the `sessionId` stored on the artifact itself, while `session.artifactIds` is a denormalised
 * copy that no display path reads. The import used to create the notebook AFTER its attachments,
 * so there was no id to stamp - and the notebook opened empty on an import that reported success,
 * with no error, no warning, and a full `artifactIds` array to point at.
 *
 * Real repositories on both sides for the same reason as above: the stamp is only worth anything
 * if the viewer's own query finds it.
 */
describe('notebook round trip: artifacts', () => {
  it('lands an imported artifact where the notebook viewer looks for it', async () => {
    await seedArtifact({ id: 'artifact_chat_1', sessionId: SESSION_ID });
    const exported = await exportOnce({ artifactIds: [] });
    expect(exported.artifacts).toHaveLength(1);

    // Cleared so the import mints a fresh id rather than preserving one, which is what importing
    // somebody else's export does.
    await Promise.all([
      Artifact.deleteMany({}, { hardDelete: true }),
      ArtifactContent.deleteMany({}, { hardDelete: true }),
    ]);

    const result = await new NotebookImportService({
      sessionRepository: createSessionWrites(),
      // The real creation path, unstubbed: it is what puts the sessionId on the stored row.
      ...createArtifactWrites(),
      chatHistoryRepository: { bulkCreate: async () => {}, deleteMany: async () => {} },
      knowledgeRepository: { create: async () => null },
      toolRepository: { create: async () => null, find: async () => [], findById: async () => null },
      agentRepository: { create: async () => null },
      userRepository: { findById: async () => ({ id: USER }) },
      fileStorageService: {
        getFileContent: async () => null,
        uploadFile: async () => {},
        getSignedUrl: async () => null,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      generateId: () => `artifact_${new mongoose.Types.ObjectId().toString()}`,
    } as never).importNotebooks(
      USER,
      { exportVersion: '1.0.0', notebooks: [exported] } as never,
      {
        importKnowledge: false,
        importArtifacts: true,
        importTools: false,
        importAgents: false,
        conflictResolution: 'rename',
        preserveIds: false,
      } as never
    );

    expect(result.errors).toEqual([]);
    expect(result.importedAttachments).toBe(1);

    const notebook = await Session.findOne({ userId: USER });
    // The assertion that matters: this is the shape of the query the artifact viewer runs
    // (`GET /api/artifacts?sessionId=`). Before the fix it returned nothing.
    const visible = await artifactRepository.find({ sessionId: String(notebook?.id) });
    expect(visible.map((a: { title: string }) => a.title)).toEqual(['Red Circle']);

    // Body too: a row the viewer finds but cannot render is not a round trip.
    const body = await artifactContentRepository.find({ artifactId: visible[0].id });
    expect(body[0]?.content).toBe(BODY);
  });
});
