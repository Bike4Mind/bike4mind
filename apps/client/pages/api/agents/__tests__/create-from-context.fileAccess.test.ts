import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins which files feed agent generation: the session's `knowledgeIds` and its messages' `fabFileIds`
 * are both client-written, and their contents go into the generated agent's prompt, so they must
 * resolve through the caller's access (with the attachment door's lake arms), never an unscoped read.
 */
const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findAccessibleInIds: vi.fn(),
  findAllByIds: vi.fn(),
  createAttachmentLakeAccess: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: vi.fn().mockResolvedValue({ id: 'sess-1', userId: 'user-1', knowledgeIds: ['stored-file'] }),
  },
  questRepository: { findAllBySessionId: vi.fn().mockResolvedValue([{ fabFileIds: ['message-file'] }]) },
  agentOpsSettingsRepository: { getSettings: vi.fn().mockResolvedValue(null) },
  fabFileRepository: { findAccessibleInIds: h.findAccessibleInIds, findAllByIds: h.findAllByIds },
  agentRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
  projectRepository: {},
}));

vi.mock('@server/queueHandlers/agentExecutor.attachmentLakeAccess', () => ({
  createAttachmentLakeAccess: h.createAttachmentLakeAccess,
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: vi.fn(), getLlmByModel: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {} }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));

await import('../create-from-context');

const LAKE_ACCESS = { lakeMemberships: [], dataLakeTags: ['lake:x'], dataLakeTagPrefixes: [] };
// Stops the handler at the file read; everything after it (LLM generation, persistence) is not
// what this suite pins.
const STOP = new Error('stop after the file read');

beforeEach(() => {
  h.findAccessibleInIds.mockReset().mockRejectedValue(STOP);
  h.findAllByIds.mockReset();
  h.createAttachmentLakeAccess.mockReset().mockReturnValue(async () => LAKE_ACCESS);
});

describe('POST /api/agents/create-from-context - file access', () => {
  it("reads the session's and messages' files through the caller's access, with lake arms", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const user = { id: 'user-1', groups: ['group-1'] };
    const req = { body: { agentName: 'Helper', sessionId: '67dbe18a7f9cf1fa5d9686aa' }, user, logger };

    await h.handler!(req, {}).catch(() => undefined);

    expect(h.findAccessibleInIds).toHaveBeenCalledWith(
      ['stored-file', 'message-file'],
      { userId: 'user-1', userGroups: ['group-1'] },
      LAKE_ACCESS
    );
    expect(h.createAttachmentLakeAccess).toHaveBeenCalledWith(user, logger);
    expect(h.findAllByIds).not.toHaveBeenCalled();
  });
});
