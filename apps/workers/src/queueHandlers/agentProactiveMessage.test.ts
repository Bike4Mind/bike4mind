/**
 * Regression for a gap found in review of #3084's fix: config.ts's PUT re-stamps a
 * session-agent-config's userId to whoever last edited it, so a queued proactive-message job
 * can race with the owner revoking that editor's session-write or agent-share grant. Without
 * revalidating access immediately before resolving keys/executing, a revoked collaborator's
 * credentials and tool access could keep executing on schedule. `canAccessSession` runs for
 * real here (not mocked) - only its inputs (the session doc) are controlled per test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  configFindById: vi.fn(),
  sessionFindById: vi.fn(),
  getAttachedAgents: vi.fn(),
  userFindById: vi.fn(),
  agentFindAccessibleById: vi.fn(),
  getMostRecentChatHistory: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  generateAndSendProactiveMessage: vi.fn(),
  sendToClient: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  sessionAgentConfigRepository: { findById: h.configFindById },
  sessionRepository: { findById: h.sessionFindById, getAttachedAgents: h.getAttachedAgents },
  agentRepository: { shareable: { findAccessibleById: h.agentFindAccessibleById } },
  questRepository: { getMostRecentChatHistory: h.getMostRecentChatHistory },
  userRepository: { findById: h.userFindById },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  imageModerationIncidentRepository: {},
  usageEventRepository: {},
  organizationRepository: {},
  scopedSettingsRepository: {},
  Connection: { find: vi.fn(), deleteOne: vi.fn() },
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));

vi.mock('@bike4mind/services/agentProactiveMessagingService', () => ({
  generateAndSendProactiveMessage: h.generateAndSendProactiveMessage,
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn(),
  ClientMessageSender: class MockClientMessageSender {
    sendToClient = h.sendToClient;
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: () => new Proxy({}, { get: () => 'mock' }),
    }
  ),
}));

import { dispatch } from './agentProactiveMessage';

const logger = { info: vi.fn(), error: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const payload = { sessionAgentConfigId: 'config-1' };

const CONFIG = {
  id: 'config-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  userId: 'editor',
  proactiveMessaging: { enabled: true },
};
const SESSION_EDITOR_HAS_WRITE = {
  id: 'session-1',
  userId: 'owner',
  users: [{ userId: 'editor', permissions: ['read', 'update'] }],
  groups: [],
};
const SESSION_EDITOR_REVOKED = { id: 'session-1', userId: 'owner', users: [], groups: [] };

describe('agentProactiveMessage consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.configFindById.mockResolvedValue(CONFIG);
    h.sessionFindById.mockResolvedValue(SESSION_EDITOR_HAS_WRITE);
    h.getAttachedAgents.mockResolvedValue(['agent-1']);
    h.userFindById.mockResolvedValue({ id: 'editor', groups: [] });
    h.agentFindAccessibleById.mockResolvedValue({ id: 'agent-1' });
    h.getMostRecentChatHistory.mockResolvedValue([]);
    h.getEffectiveLLMApiKeys.mockResolvedValue({});
    h.generateAndSendProactiveMessage.mockResolvedValue(undefined);
    h.sendToClient.mockResolvedValue(undefined);
  });

  it('executes when config.userId still has write access to the session and can still reach the agent', async () => {
    await dispatch(makeEvent(payload), {} as never, logger);

    expect(h.generateAndSendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(h.sendToClient).toHaveBeenCalledTimes(2);
  });

  it('skips without executing when config.userId no longer has write access to the session (revoked session grant)', async () => {
    h.sessionFindById.mockResolvedValue(SESSION_EDITOR_REVOKED);

    await dispatch(makeEvent(payload), {} as never, logger);

    expect(h.agentFindAccessibleById).not.toHaveBeenCalled();
    expect(h.getEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(h.generateAndSendProactiveMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no longer has write access'));
  });

  it('skips without executing when config.userId no longer has access to the agent (revoked agent grant)', async () => {
    h.agentFindAccessibleById.mockResolvedValue(null);

    await dispatch(makeEvent(payload), {} as never, logger);

    expect(h.getEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(h.generateAndSendProactiveMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no longer has access to agent'));
  });
});
