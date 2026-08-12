import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, Session } from '@bike4mind/database';
import { notebookImportService } from '@bike4mind/services';
import { createChatHistoryWrites, createSessionWrites } from './notebookImportComplete';

/**
 * Knowledge files were built with field names the schema does not have (`name`/`size`/`path` rather
 * than `fileName`/`fileSize`/`filePath`) and no `type`, which is required. Mongoose stripped the
 * unknown keys and rejected the rest, every failure was swallowed into a log line, and the import
 * reported success with a count of the files it had not written.
 *
 * Drives the REAL service through the REAL FabFile model. Run
 * `pnpm --filter @bike4mind/services build` first: the service comes from the built dist, so a
 * stale build reports green against whatever was last compiled.
 */

const { NotebookImportService } = notebookImportService;

let mongoServer: MongoMemoryServer;
const USER = 'knowledge-import-owner';

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 60000);
afterEach(async () => {
  await Promise.all([FabFile.deleteMany({}, { hardDelete: true }), Session.deleteMany({}, { hardDelete: true })]);
});

function payload(knowledge: Record<string, unknown>[]) {
  return {
    exportVersion: '1.0.0',
    notebooks: [
      {
        id: 'nb-1',
        name: 'Notebook With Files',
        firstCreated: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-02T00:00:00.000Z',
        chatHistory: [],
        knowledge,
        artifacts: [],
        tools: [],
        agents: [],
      },
    ],
  };
}

function knowledgeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kf-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 11,
    content: Buffer.from('hello world').toString('base64'),
    uploadedAt: '2026-01-01T00:00:00.000Z',
    type: 'FILE',
    metadata: {},
    ...overrides,
  };
}

function makeService(uploaded: string[] = []) {
  const adapters = {
    sessionRepository: createSessionWrites(),
    chatHistoryRepository: createChatHistoryWrites(),
    // The real model write the handler performs, so a schema mismatch fails here as it does live.
    knowledgeRepository: { create: async (d: Record<string, unknown>) => (await FabFile.create([d]))[0] },
    artifactRepository: { create: async () => null },
    toolRepository: { create: async () => null },
    agentRepository: { create: async () => null },
    userRepository: { findById: async () => ({ id: USER }) },
    fileStorageService: {
      uploadFile: async (path: string) => {
        uploaded.push(path);
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    generateId: () => new mongoose.Types.ObjectId().toString(),
  };
  return new NotebookImportService(adapters as never);
}

const OPTIONS = {
  importKnowledge: true,
  importArtifacts: false,
  importTools: false,
  importAgents: false,
  conflictResolution: 'rename',
  preserveIds: false,
};

describe('notebook import writes knowledge files', () => {
  it('persists the file with the schema field names', async () => {
    const uploaded: string[] = [];
    const result = await makeService(uploaded).importNotebooks(
      USER,
      payload([knowledgeFile()]) as never,
      OPTIONS as never
    );

    expect(result.errors).toEqual([]);

    const file = await FabFile.findOne({ userId: USER });
    expect(file).toBeTruthy();
    expect(file?.fileName).toBe('notes.txt');
    expect(file?.fileSize).toBe(11);
    expect(file?.mimeType).toBe('text/plain');
    // The bytes were uploaded to this path, so the record has to point at the same one.
    expect(file?.filePath).toBe(uploaded[0]);
    expect(result.importedAttachments).toBe(1);
  }, 60000);

  it('carries the original knowledge type through the export', async () => {
    await makeService().importNotebooks(USER, payload([knowledgeFile({ type: 'URL' })]) as never, OPTIONS as never);

    expect((await FabFile.findOne({ userId: USER }))?.type).toBe('URL');
  }, 60000);

  it('falls back to FILE for exports written before type was carried', async () => {
    await makeService().importNotebooks(USER, payload([knowledgeFile({ type: undefined })]) as never, OPTIONS as never);

    expect((await FabFile.findOne({ userId: USER }))?.type).toBe('FILE');
  }, 60000);

  it('records an id on the notebook that resolves to the file it wrote', async () => {
    await makeService().importNotebooks(USER, payload([knowledgeFile()]) as never, OPTIONS as never);

    const notebook = await Session.findOne({ userId: USER });
    const file = await FabFile.findOne({ userId: USER });

    expect(notebook?.knowledgeIds).toHaveLength(1);
    expect(notebook?.knowledgeIds?.[0]).toBe(String(file?.id));
  }, 60000);

  it('keeps the notebook and the files that worked when one file fails', async () => {
    const broken = knowledgeFile({ id: 'kf-2', name: 'broken.txt', content: undefined });

    const result = await makeService().importNotebooks(
      USER,
      payload([knowledgeFile(), broken]) as never,
      OPTIONS as never
    );

    // The whole point: a file that cannot be written must not take the notebook with it. The
    // handler aborts the transaction on `errors`, so this staying empty is what protects it.
    expect(result.errors).toEqual([]);
    expect(result.importedNotebooks).toBe(1);
    expect(result.importedAttachments).toBe(1);
    expect(await FabFile.countDocuments({})).toBe(1);

    const notebook = await Session.findOne({ userId: USER });
    const file = await FabFile.findOne({ userId: USER });
    expect(notebook?.knowledgeIds).toEqual([String(file?.id)]);
    expect(result.warnings?.[0]).toContain('broken.txt');
  }, 60000);

  it('degrades an unrecognised type rather than losing the file', async () => {
    await makeService().importNotebooks(
      USER,
      payload([knowledgeFile({ type: 'SOMETHING_NEWER' })]) as never,
      OPTIONS as never
    );

    expect((await FabFile.findOne({ userId: USER }))?.type).toBe('FILE');
  }, 60000);

  it('warns once, not twice, when a file has an unknown type and also fails to write', async () => {
    // Content resolves, so the upload succeeds and the loop reaches the write - which then fails
    // on the missing required `fileName`. That is the only ordering where both warnings compete.
    const result = await makeService().importNotebooks(
      USER,
      payload([knowledgeFile({ type: 'SOMETHING_NEWER', name: undefined })]) as never,
      OPTIONS as never
    );

    // "imported as FILE" only makes sense for a file that landed, so a file that failed must
    // produce exactly one warning - the failure - not that plus a type note.
    expect(await FabFile.countDocuments({})).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('Failed to import knowledge file');
  }, 60000);

  it('reports a failed attachment instead of claiming success', async () => {
    // No content and no contentUrl: the service cannot resolve a path, so this one must fail.
    const broken = knowledgeFile({ content: undefined });

    const result = await makeService().importNotebooks(USER, payload([broken]) as never, OPTIONS as never);

    // Reported, but NOT in `errors`: the handler rolls the whole import back on `errors`, so a
    // single unreadable file must not discard the notebooks that imported cleanly.
    expect(result.errors).toEqual([]);
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings?.[0]).toContain('notes.txt');
    // The count must reflect what landed, not what the file claimed.
    expect(result.importedAttachments).toBe(0);
  }, 60000);
});
