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
  findByDatalakeTag: vi.fn(async () => null as { createdByUserId: string } | null),
  canManageLake: vi.fn(() => false),
  userFindById: vi.fn(async (id: string) => ({ id, isAdmin: false })),
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
  User: { findById: h.userFindById },
  Quest: {
    find: vi.fn(() => ({
      sort: () => ({ limit: async () => [{ _id: 'q1', prompt: 'hello', reply: 'world' }] }),
    })),
  },
  sessionRepository: { update: h.sessionUpdate },
  fabFileRepository: { findOne: h.findOne },
  dataLakeRepository: { find: vi.fn(), findByDatalakeTag: h.findByDatalakeTag },
  adminSettingsRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { updateFabFile: h.updateFabFile, createFabFile: h.createFabFile },
  dataLakeService: {
    loadPrefixArmCandidateLakes: h.findPrefixArmLakes,
    // Real (not faked) extraction logic: cheap, pure, and this is exactly what the code under
    // test needs to see the tags it passes as meta-tags or not.
    extractDataLakeMetaTags: (names: unknown[]) =>
      Array.from(
        new Set(
          names
            .filter((n): n is string => typeof n === 'string')
            .map(n => n.toLowerCase())
            .filter(n => n.startsWith('datalake:'))
        )
      ),
    canManageLake: h.canManageLake,
    // Real (not faked): a fixed test-only prefix, mirroring the shape of DATA_LAKES' opti: entry.
    extractStaticRegistryPrefixedTags: (names: unknown[]) =>
      names.filter((n): n is string => typeof n === 'string' && n.startsWith('opti:')),
    // Real (not faked): a fixed test-only static-registry datalakeTag, mirroring
    // DATA_LAKES' opti-knowledge entry (datalake:opti-knowledge, no owning DB document).
    isStaticRegistryDatalakeTag: (tag: string) => tag.toLowerCase() === 'datalake:opti-knowledge',
  },
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

  // A stored meta-tag or prefix-arm content tag is never carried through by hand here -
  // reconcileLakeTags (called inside updateFabFile) preserves existing membership regardless of
  // what this door sends, so re-summarization can just pass the session's own tags through as-is
  // without silently evicting a lake-indexed file it never actually left.
  it("passes only the session's own tags to updateFabFile, relying on the callee to preserve lake membership", async () => {
    // The session (h.session.tags, defaulted to [] in beforeEach) carries neither signal - the
    // stored FabFile's existing meta-tag and prefix-arm tag are NOT manually carried through here.
    h.fabFileStore.push({
      id: 'fabfile-owner',
      userId: OWNER,
      sessionId: SESSION_ID,
      fileName: 'Notebook Summary.txt',
      tags: [
        { name: 'datalake:lake1', strength: 1 },
        { name: 'lk:invoices', strength: 1 },
      ],
    });

    await run();

    expect(h.updateFabFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: [] }),
      expect.anything()
    );
    expect(h.findPrefixArmLakes).not.toHaveBeenCalled();
  });

  // createFabFile's new lake-tag gate (see fabFileService/create.ts) now throws for a datalake:
  // meta-tag the session's user cannot manage, where before this PR it landed on the file
  // ungated - the bug #1101 describes. A stale/unmanageable tag on an otherwise-unrelated session
  // must not take the whole summary down with it.
  describe('an unmanageable datalake: tag on a brand-new summary', () => {
    beforeEach(() => {
      h.session = {
        id: SESSION_ID,
        _id: SESSION_ID,
        userId: OWNER,
        name: 'Notebook',
        tags: [{ name: 'datalake:someone-elses-lake' }, { name: 'plain' }],
      };
      h.canManageLake.mockReturnValue(false);
    });

    it('drops it and still creates the summary with the rest of the tags', async () => {
      await run();

      expect(h.createFabFile).toHaveBeenCalledTimes(1);
      const [, data] = h.createFabFile.mock.calls[0] as [string, { tags: { name: string }[] }];
      expect(data.tags.map(t => t.name)).toEqual(['plain']);
    });

    it('logs a warning naming the dropped tag', async () => {
      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('datalake:someone-elses-lake'));
    });

    it('keeps a tag the session user CAN manage', async () => {
      h.findByDatalakeTag.mockResolvedValueOnce({ createdByUserId: OWNER });
      h.canManageLake.mockReturnValue(true);

      await run();

      const [, data] = h.createFabFile.mock.calls[0] as [string, { tags: { name: string }[] }];
      expect(data.tags.map(t => t.name)).toEqual(['datalake:someone-elses-lake', 'plain']);
    });
  });

  // A legacy static-registry content tag (e.g. opti:foo) predating this fix's rollout can be
  // sitting on a session too - same reasoning as the datalake: meta-tag case, no DB lookup needed
  // since that arm is admin-only.
  describe('a legacy static-registry content tag on a brand-new summary', () => {
    beforeEach(() => {
      h.session = {
        id: SESSION_ID,
        _id: SESSION_ID,
        userId: OWNER,
        name: 'Notebook',
        tags: [{ name: 'opti:legacy' }, { name: 'plain' }],
      };
    });

    it('drops it for a non-admin and still creates the summary with the rest of the tags', async () => {
      await run();

      const [, data] = h.createFabFile.mock.calls[0] as [string, { tags: { name: string }[] }];
      expect(data.tags.map(t => t.name)).toEqual(['plain']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('opti:legacy'));
    });
  });

  // A static-registry lake's meta-tag (datalake:opti-knowledge) has no owning DB document, so
  // findByDatalakeTag returns null for it - naively treating that as "unmanageable" would drop
  // the tag even for an admin the real createFabFile gate would let keep it (bot review finding).
  describe('a static-registry datalake: meta-tag on a brand-new summary', () => {
    beforeEach(() => {
      h.session = {
        id: SESSION_ID,
        _id: SESSION_ID,
        userId: OWNER,
        name: 'Notebook',
        tags: [{ name: 'datalake:opti-knowledge' }, { name: 'plain' }],
      };
    });

    it('drops it for a non-admin with no DB lookup', async () => {
      await run();

      const [, data] = h.createFabFile.mock.calls[0] as [string, { tags: { name: string }[] }];
      expect(data.tags.map(t => t.name)).toEqual(['plain']);
      expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    });

    it('keeps it for an admin, matching what createFabFile would actually allow', async () => {
      h.userFindById.mockResolvedValueOnce({ id: OWNER, isAdmin: true });

      await run();

      const [, data] = h.createFabFile.mock.calls[0] as [string, { tags: { name: string }[] }];
      expect(data.tags.map(t => t.name)).toEqual(['datalake:opti-knowledge', 'plain']);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
