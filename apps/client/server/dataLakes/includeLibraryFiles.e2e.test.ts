/**
 * End-to-end guard for the session `includeLibraryFiles` flag against REAL Mongo: forced retrieval
 * and search_knowledge_base must cite the same corpus for the same session, and that corpus must
 * leave the caller's own library out exactly when the flag (or, unset, a named lake) says so. Only
 * the embedding provider is stubbed; lake access, the ownership query and the files are real.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => [1, 0] };
      }
    },
  };
});

import {
  DataLakeModel as DataLake,
  FabFile,
  FabFileChunk,
  User,
  adminSettingsRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
} from '@bike4mind/database';
import { KnowledgeType, libraryFlagForScope, type CitableSource } from '@bike4mind/common';
import { KnowledgeRetrievalFeature, b4mTools } from '@bike4mind/services/llm';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const LAKE_TAG = 'datalake:e2e-lake';
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

let mongoServer: MongoMemoryServer;
let userId: string;
let lakeFileId: string;
let personalFileId: string;
let sharedFileId: string;

async function makeFile(fileName: string, tags: { name: string }[], sharedBy?: string) {
  const doc = await FabFile.create({
    userId: sharedBy ?? userId,
    ...(sharedBy ? { users: [{ userId, permissions: ['read'] }] } : {}),
    type: KnowledgeType.FILE,
    fileName,
    tags,
    vectorized: true,
    embeddingModel: 'text-embedding-ada-002',
    chunkCount: 1,
    vectorizedChunkCount: 1,
  });
  await FabFileChunk.create({
    fabFileId: String(doc._id),
    text: `${fileName} protocol`,
    tokenCount: 4,
    vector: [1, 0],
  });
  return String(doc._id);
}

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([FabFile.init(), FabFileChunk.init(), DataLake.init()]);
  const user = await User.create({ username: 'lake-owner', name: 'Lake Owner' });
  userId = user.id as string;
  await DataLake.create({
    name: 'E2E Lake',
    slug: 'e2e-lake',
    datalakeTag: LAKE_TAG,
    fileTagPrefix: 'e2e-lake:',
    status: 'active',
    createdByUserId: userId,
  });
  lakeFileId = await makeFile('lake protocol.pdf', [{ name: LAKE_TAG }]);
  personalFileId = await makeFile('personal protocol.pdf', []);
  const colleague = await User.create({ username: 'colleague', name: 'Colleague' });
  sharedFileId = await makeFile('shared protocol.pdf', [], colleague.id as string);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

interface SessionShape {
  retrievalTags?: string[];
  lakeScopeExplicit?: boolean;
  forceKnowledgeRetrieval?: boolean;
  includeLibraryFiles?: boolean;
  attachedFileIds?: string[];
}

const db = {
  fabfiles: fabFileRepository,
  fabfilechunks: fabFileChunkRepository,
  dataLakes: dataLakeRepository,
  organizations: organizationRepository,
  adminSettings: adminSettingsRepository,
};

async function forcedRetrievalCitables(s: SessionShape): Promise<string[]> {
  const quest = { id: 'q1', sessionId: 's1', prompt: 'protocol', promptMeta: {} } as Record<string, unknown>;
  const ctx = {
    logger,
    user: { id: userId, tags: [], groups: [] },
    db,
    resolveEntitlementKeys: async () => ({ keys: [], resolved: true }),
    sendStatusUpdate: async () => undefined,
  };
  const feature = new KnowledgeRetrievalFeature(
    ctx as never,
    s.retrievalTags ?? [],
    undefined,
    undefined,
    undefined,
    s.lakeScopeExplicit ?? false,
    undefined,
    libraryFlagForScope(s)
  );
  const embeddingFactory = {
    createEmbeddingService: () => ({ generateEmbedding: async () => [1, 0] }),
    getDefaultEmbeddingModel: () => 'text-embedding-ada-002',
  };
  await feature.getContextMessages(quest as never, embeddingFactory as never, 'protocol');
  const meta = quest.promptMeta as { citables?: CitableSource[] };
  return (meta.citables ?? []).map(c => String(c.id)).sort();
}

function toolContext(s: SessionShape, sink: { citables: CitableSource[] }) {
  return {
    userId,
    user: { id: userId, groups: [] },
    sessionId: 's1',
    questId: 'q1',
    logger,
    // Keyword arm: no chunk repository, so the semantic arm bows out and the real ownership query runs.
    db: { fabfiles: fabFileRepository, dataLakes: dataLakeRepository, organizations: organizationRepository },
    sessionRetrievalTags: s.retrievalTags,
    sessionLakeScopeExplicit: s.lakeScopeExplicit,
    sessionIncludeLibraryFiles: libraryFlagForScope(s),
    attachedFileIds: s.attachedFileIds,
    statusUpdate: async (u: { promptMeta?: { citables?: CitableSource[] } }) => {
      if (u.promptMeta?.citables) sink.citables.push(...u.promptMeta.citables);
    },
  } as never;
}

async function searchToolCitables(s: SessionShape): Promise<string[]> {
  const sink = { citables: [] as CitableSource[] };
  await b4mTools.search_knowledge_base.implementation(toolContext(s, sink), undefined).toolFn({ query: 'protocol' });
  return sink.citables.map(c => String(c.id)).sort();
}

async function retrieveById(s: SessionShape, fileId: string): Promise<string> {
  const sink = { citables: [] as CitableSource[] };
  const base = toolContext(s, sink) as unknown as { db: Record<string, unknown> };
  const ctx = { ...base, db: { ...base.db, fabfilechunks: fabFileChunkRepository } };
  const tool = b4mTools.retrieve_knowledge_content.implementation(ctx as never, undefined);
  return String(await tool.toolFn({ file_id: fileId }));
}

const both = () => [lakeFileId, personalFileId, sharedFileId].sort();

describe('includeLibraryFiles against real Mongo', () => {
  it.each<[string, SessionShape, 'lake' | 'both']>([
    ['explicit lake, off', { retrievalTags: [LAKE_TAG], lakeScopeExplicit: true, includeLibraryFiles: false }, 'lake'],
    ['all lakes, off', { retrievalTags: [], includeLibraryFiles: false }, 'lake'],
    ['explicit lake, on', { retrievalTags: [LAKE_TAG], lakeScopeExplicit: true, includeLibraryFiles: true }, 'both'],
    ['legacy lake chat, unset', { retrievalTags: [LAKE_TAG], forceKnowledgeRetrieval: true }, 'lake'],
    ['plain chat with an attached lake file, unset', { retrievalTags: [LAKE_TAG] }, 'both'],
    ['plain chat, unset', {}, 'both'],
  ])('%s: forced retrieval and search_knowledge_base cite the %s corpus', async (_, session, expected) => {
    const want = expected === 'lake' ? [lakeFileId] : both();
    expect(await forcedRetrievalCitables(session)).toEqual(want);
    expect(await searchToolCitables(session)).toEqual(want);
  });

  it('a file shared with the caller but in no lake follows the library, not the lake', async () => {
    const off = { retrievalTags: [LAKE_TAG], lakeScopeExplicit: true, includeLibraryFiles: false };
    expect(await forcedRetrievalCitables(off)).not.toContain(sharedFileId);
    expect(await searchToolCitables(off)).not.toContain(sharedFileId);
    expect(await searchToolCitables({ ...off, includeLibraryFiles: true })).toContain(sharedFileId);
  });

  it('a content-tag session keeps the library in search_knowledge_base', async () => {
    expect(await searchToolCitables({ retrievalTags: ['legal:review'] })).toContain(personalFileId);
  });

  it('retrieve opens a personal file in a library-off lake chat only when it is attached', async () => {
    const off = { retrievalTags: [LAKE_TAG], lakeScopeExplicit: true, includeLibraryFiles: false };
    expect(await retrieveById(off, personalFileId)).not.toContain('Retrieved content from');
    expect(await retrieveById({ ...off, attachedFileIds: [personalFileId] }, personalFileId)).toContain(
      'Retrieved content from'
    );
    expect(await retrieveById(off, lakeFileId)).toContain('Retrieved content from');
  });
});
