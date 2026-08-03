import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER = 'session-owner';
const STRANGER = 'someone-else';
const SESSION_ID = 'session-1';

const h = vi.hoisted(() => {
  const state = {
    fabFiles: [] as { id: string; sessionId: string; userId: string; tags: { name: string }[] }[],
    updateFabFile: vi.fn(),
    createFabFile: vi.fn(),
    sessionUpdate: vi.fn(),
    upload: vi.fn(),
    // A filter-APPLYING double, not a canned return: it matches the store the way Mongo would, so
    // dropping the userId conjunct at the call site really does surface the stranger's row here.
    // A findOne stubbed to return one fixed document would pass either way.
    findOne: vi.fn(),
  };
  state.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
    const match = state.fabFiles.find(f =>
      Object.entries(filter).every(([k, v]) => (f as unknown as Record<string, unknown>)[k] === v)
    );
    return match ?? null;
  });
  return state;
});

vi.mock('@server/events/utils', () => ({
  withEventContext: (fn: unknown) => fn,
}));

vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Summarize: { schema: { parse: (p: unknown) => p } },
    Tag: { publish: vi.fn() },
  },
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  Session: { findById: async () => ({ id: SESSION_ID, userId: OWNER, name: 'Notebook', tags: [], summary: '' }) },
  User: { findById: async () => ({ id: OWNER }) },
  Quest: {
    find: () => ({ sort: () => ({ limit: async () => [{ _id: 'q1', prompt: 'p', reply: 'r' }] }) }),
  },
  fabFileRepository: { findOne: h.findOne },
  sessionRepository: { update: h.sessionUpdate },
  dataLakeRepository: {},
  adminSettingsRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'test-model',
      modelInfo: { name: 'test-model', backend: 'test' },
      llm: {
        complete: async (
          _id: string,
          _messages: unknown,
          _options: unknown,
          onChunk: (chunk: unknown[], info?: unknown) => Promise<void>
        ) => {
          await onChunk(['a summary'], undefined);
        },
      },
    }),
  },
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { updateFabFile: h.updateFabFile, createFabFile: h.createFabFile },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.upload, getSignedUrl: vi.fn() }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: vi.fn() }));

import { handler } from './sessionSummarization';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { event: 'Session.Summarize', properties: { sessionId: SESSION_ID, callTagging: false, trigger: 'test' } },
    logger
  );

describe('sessionSummarization - summary FabFile lookup is owner-scoped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.fabFiles = [];
    h.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      const match = h.fabFiles.find(f =>
        Object.entries(filter).every(([k, v]) => (f as unknown as Record<string, unknown>)[k] === v)
      );
      return match ?? null;
    });
    h.createFabFile.mockResolvedValue({ id: 'new-file', filePath: 'path/to/summary.txt', mimeType: 'text/plain' });
    h.updateFabFile.mockResolvedValue({ id: 'updated-file' });
  });

  it('creates a new summary file rather than overwriting a stranger FabFile on the same session', async () => {
    h.fabFiles = [{ id: 'stranger-file', sessionId: SESSION_ID, userId: STRANGER, tags: [] }];

    await run();

    // The whole point: this file belongs to someone else and must not be written at all.
    expect(h.updateFabFile).not.toHaveBeenCalled();
    expect(h.createFabFile).toHaveBeenCalledWith(OWNER, expect.objectContaining({ userId: OWNER }), expect.anything());
  });

  it('still updates the session owner own summary file', async () => {
    h.fabFiles = [{ id: 'owner-file', sessionId: SESSION_ID, userId: OWNER, tags: [] }];

    await run();

    expect(h.createFabFile).not.toHaveBeenCalled();
    expect(h.updateFabFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'owner-file' }),
      expect.anything()
    );
  });

  it('picks the owner file even when a stranger file is stored ahead of it', async () => {
    // Ordering matters: an unscoped findOne returns whichever row Mongo reaches first, so a store
    // that happens to hold the owner first would let the missing conjunct pass unnoticed.
    h.fabFiles = [
      { id: 'stranger-file', sessionId: SESSION_ID, userId: STRANGER, tags: [] },
      { id: 'owner-file', sessionId: SESSION_ID, userId: OWNER, tags: [] },
    ];

    await run();

    expect(h.updateFabFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'owner-file' }),
      expect.anything()
    );
  });

  it('carries the owner conjunct on the lookup itself', async () => {
    await run();

    expect(h.findOne).toHaveBeenCalledWith({ sessionId: SESSION_ID, userId: OWNER });
  });
});
