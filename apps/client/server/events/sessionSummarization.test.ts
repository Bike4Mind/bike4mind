/**
 * The summary FabFile lookup is an ownership boundary: a sessionId is attacker-settable via
 * PUT /api/files/[id], so a lookup by session id alone can hand the summarizer a stranger's
 * document to overwrite. The `findOne` fake below honours whatever filter it is given, so
 * dropping the owner conjunct from the handler changes which document is selected and fails
 * these tests rather than quietly passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fabFileStore: [] as Record<string, unknown>[],
  findOne: vi.fn(),
  updateFabFile: vi.fn(),
  createFabFile: vi.fn(),
  sessionUpdate: vi.fn(),
  publishTag: vi.fn(),
  logEvent: vi.fn(),
  upload: vi.fn(),
  findPrefixArmLakes: vi.fn(
    async () => [] as { createdByUserId: string; fileTagPrefix: string; datalakeTag: string }[]
  ),
  session: {} as Record<string, unknown>,
}));

// Passthrough the wrapper so the raw handler runs without connectDB / Config.
vi.mock('@server/events/utils', () => ({
  withEventContext: (fn: unknown) => fn,
}));

vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Summarize: { schema: { parse: (properties: unknown) => properties } },
    Tag: { publish: h.publishTag },
  },
}));

vi.mock('@bike4mind/database', () => ({
  Session: { findById: vi.fn(async () => h.session) },
  User: { findById: vi.fn(async (id: string) => ({ id, isAdmin: false })) },
  Quest: {
    find: vi.fn(() => ({
      sort: () => ({ limit: async () => [{ _id: 'q1', prompt: 'hello', reply: 'world' }] }),
    })),
  },
  sessionRepository: { update: h.sessionUpdate },
  fabFileRepository: { findOne: h.findOne },
  dataLakeRepository: { find: vi.fn() },
  adminSettingsRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { updateFabFile: h.updateFabFile, createFabFile: h.createFabFile },
  dataLakeService: { loadPrefixArmCandidateLakes: h.findPrefixArmLakes },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'test-model',
      modelInfo: { name: 'Test Model', backend: 'test' },
      llm: {
        complete: async (
          _modelId: string,
          _messages: unknown,
          _options: unknown,
          onChunk: (chunk: (string | null)[]) => Promise<void>
        ) => {
          await onChunk(['A summary of the session.']);
        },
      },
    }),
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.upload, getSignedUrl: vi.fn(async () => 'https://example.test/signed') }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/events/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: vi.fn(),
}));

import { handler } from './sessionSummarization';

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const SESSION_ID = 'session-1';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { event: 'session.summarize', properties: { sessionId: SESSION_ID, trigger: 'manual' } },
    logger
  );

describe('sessionSummarization summary-file lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.fabFileStore.length = 0;
    h.session = { id: SESSION_ID, _id: SESSION_ID, userId: OWNER, name: 'Notebook', tags: [] };
    h.findOne.mockImplementation(
      async (filter: Record<string, unknown>) =>
        h.fabFileStore.find(doc => Object.entries(filter).every(([key, value]) => doc[key] === value)) ?? null
    );
    h.createFabFile.mockResolvedValue({ filePath: 'summary.txt', mimeType: 'text/plain' });
  });

  it('looks the summary file up by session id AND the session owner', async () => {
    await run();

    expect(h.findOne).toHaveBeenCalledWith({ sessionId: SESSION_ID, userId: OWNER });
  });

  it('leaves a stranger-owned file carrying the session id alone and creates its own summary', async () => {
    h.fabFileStore.push({
      id: 'fabfile-stranger',
      userId: STRANGER,
      sessionId: SESSION_ID,
      fileName: 'Their notes.txt',
      tags: [],
    });

    await run();

    expect(h.updateFabFile).not.toHaveBeenCalled();
    expect(h.createFabFile).toHaveBeenCalledWith(OWNER, expect.objectContaining({ userId: OWNER }), expect.anything());
  });

  it('refuses to summarize an owner-less session instead of running an unscoped lookup', async () => {
    // A missing userId would be dropped from the filter, leaving the lookup keyed on sessionId
    // alone. The event carries its own userId here, which is what gets an owner-less session
    // past the `!user` check on the spider and agent-run paths.
    h.session = { id: SESSION_ID, _id: SESSION_ID, name: 'Notebook', tags: [] };
    h.fabFileStore.push({ id: 'fabfile-stranger', userId: STRANGER, sessionId: SESSION_ID, tags: [] });

    await (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
      { event: 'session.summarize', properties: { sessionId: SESSION_ID, userId: STRANGER, trigger: 'manual' } },
      logger
    );

    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.updateFabFile).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has no owner'));
  });

  it('stays silent about ownership on the healthy path', async () => {
    await run();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("updates the owner's existing summary file", async () => {
    h.fabFileStore.push({
      id: 'fabfile-owner',
      userId: OWNER,
      sessionId: SESSION_ID,
      fileName: 'Notebook Summary.txt',
      tags: [],
    });

    await run();

    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(h.updateFabFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'fabfile-owner' }),
      expect.anything()
    );
  });

  // Since #1263, a prefix-arm content tag is lake membership on its own (no meta-tag required),
  // and reconcileLakeTags now gates losing it the same as a meta-tag leave. Re-summarizing must
  // carry that tag through too, or it silently evicts the file from a lake it never left.
  it('carries a prefix-arm-only membership tag through re-summarization', async () => {
    h.fabFileStore.push({
      id: 'fabfile-owner',
      userId: OWNER,
      sessionId: SESSION_ID,
      fileName: 'Notebook Summary.txt',
      tags: [{ name: 'lk:invoices', strength: 1 }],
    });
    h.findPrefixArmLakes.mockResolvedValueOnce([
      { createdByUserId: OWNER, fileTagPrefix: 'lk:', datalakeTag: 'datalake:lake1' },
    ]);

    await run();

    expect(h.updateFabFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.arrayContaining([expect.objectContaining({ name: 'lk:invoices' })]) }),
      expect.anything()
    );
  });
});
