import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasAdminPermission } from '@bike4mind/common';
// The same module instance the handler imports, so the assertion below pins identity, not a copy.
import { premiumWorkspaceDeniedTools } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceDeniedTools.generated';
import { premiumWorkspaceSessionSettings } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceSessionSettings.generated';

// This exercises only the db-adapter assembly in getStaticOptions: the surface
// save_content_to_data_lake (-> saveContentAdapters in adapters.ts) reads from. Mocks mirror
// slackQuestProcessor.failureNotice.test.ts - only the thin edges (config, event bus, DB
// models, Slack client) are stubbed.

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get() {
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({
  initializeSlackPackage: vi.fn(),
}));

const mockChatOptions = vi.hoisted(() => vi.fn());
const mockChatProcess = vi.hoisted(() => vi.fn());
const mockResolveCallableFunctions = vi.hoisted(() => vi.fn(async (_user: unknown) => true));

vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: mockResolveCallableFunctions,
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-${String(key)}`,
  }),
}));

vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  LLMEvents: {
    SlackCompletionStart: { schema: { parse: (v: unknown) => v } },
    CompletionCompleted: { publish: vi.fn() },
  },
  SessionEvents: { AutoName: { publish: vi.fn() } },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({ download: vi.fn() }),
}));

vi.mock('@bike4mind/server-utils/utils/chatCompletionDefaults', () => ({
  getSharedTokenizer: () => ({}),
  publishTelemetryAlertCallback: vi.fn(),
  publishModerationEscalation: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: () => 'xoxb-decrypted',
}));

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    ChatCompletionProcess: class {
      constructor(options: unknown) {
        mockChatOptions(options);
      }
      process = mockChatProcess;
    },
  };
});

vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return {
    ...actual,
    SlackClient: class {
      updateMessage = vi.fn();
      uploadFile = vi.fn();
    },
  };
});

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    Quest: {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findOne: vi.fn(() => ({ sort: () => null })),
    },
    Session: { findById: vi.fn(async () => ({ userId: 'user-1' })) },
    User: { findById: vi.fn(async () => ({ _id: 'user-1' })) },
    sessionRepository: { findById: vi.fn(async () => ({ id: 'session-1' })) },
    slackDevWorkspaceRepository: { findByIdWithCredentials: vi.fn() },
  };
});

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

describe('slackQuestProcessor getStaticOptions', () => {
  it('wires the shared operational billing adapter into tool execution', async () => {
    const { getStaticOptions } = await import('./slackQuestProcessor');
    const { operationalBillingAdapters } = await import('@bike4mind/server-utils/billing/operationalBilling');

    expect(getStaticOptions().db.operationalBilling).toBe(operationalBillingAdapters);
  }, 120_000);

  it('wires the save_content_to_data_lake audit adapters', async () => {
    // The handler's transitive import graph (services + database + slack) is heavy enough
    // that resolving it inside a test can exceed the default timeout.
    const { getStaticOptions } = await import('./slackQuestProcessor');

    const { db } = getStaticOptions();

    // Without any one of these, saveContentAdapters() in
    // b4m-core/services/src/llm/tools/implementation/dataLakeContent/adapters.ts returns null and
    // the tool answers NOT_AVAILABLE instead of saving.
    expect(db.lakeMembershipRemovals).toBeDefined();
    expect(db.lakeConfigChangeEvents).toBeDefined();
    expect(db.lakeMembershipChangeEvents).toBeDefined();
  }, 120_000);

  // This factory is hand-maintained (unlike the shared defaults), so losing the table here
  // silently re-opens every surface denial on the Slack route only.
  it('carries the contributed surface denials into the options', async () => {
    const { getStaticOptions } = await import('./slackQuestProcessor');

    expect(getStaticOptions().workspaceDeniedTools).toBe(premiumWorkspaceDeniedTools);
    expect(getStaticOptions().workspaceSessionSettings).toBe(premiumWorkspaceSessionSettings);
  }, 120_000);

  it('wires the moderation escalation notifier', async () => {
    const { getStaticOptions } = await import('./slackQuestProcessor');
    const { publishModerationEscalation } = await import('@bike4mind/server-utils/utils/chatCompletionDefaults');

    expect(getStaticOptions().notifyModerationEscalation).toBe(publishModerationEscalation);
  }, 120_000);
});

describe('slackQuestProcessor role-held admin permissions', () => {
  const ROLE_ID = 'a'.repeat(24);
  const DELETED_ROLE_ID = 'c'.repeat(24);
  const stop = new Error('stop after the user load');
  const event = {
    'detail-type': 'slack.completion.started',
    detail: { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {} },
  } as never;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockChatProcess.mockRejectedValue(stop);
    const { adminRoleRepository } = await import('@bike4mind/database');
    vi.spyOn(adminRoleRepository, 'findByIds').mockResolvedValue([{ permissions: ['settings:manage'] }] as never);
  });

  async function runWithUser(fields: Record<string, unknown>) {
    const { User } = await import('@bike4mind/database');
    vi.mocked(User.findById).mockResolvedValueOnce({ _id: 'user-1', id: 'user-1', ...fields } as never);
    const { handler } = await import('./slackQuestProcessor');
    return (handler as unknown as (e: never) => Promise<void>)(event);
  }

  const handedUser = () => mockChatOptions.mock.calls.at(-1)?.[0].user as Parameters<typeof hasAdminPermission>[0];

  it('hands the completion a user whose only grant comes from a role', async () => {
    await expect(runWithUser({ adminRoleIds: [ROLE_ID] })).rejects.toThrow(stop.message);

    expect(hasAdminPermission(handedUser(), 'settings:manage')).toBe(true);
  }, 120_000);

  it('hands process() a resolver that asks whether callable functions are on for the turn owner', async () => {
    await expect(runWithUser({})).rejects.toThrow(stop.message);
    const { callableFunctionsResolver } = mockChatProcess.mock.lastCall?.[0] as {
      callableFunctionsResolver: () => Promise<boolean>;
    };

    await expect(callableFunctionsResolver()).resolves.toBe(true);
    expect(mockResolveCallableFunctions).toHaveBeenCalledWith(handedUser());
  }, 120_000);

  it('refuses the permission on the next call once the role is removed', async () => {
    await expect(runWithUser({ adminRoleIds: [ROLE_ID] })).rejects.toThrow(stop.message);
    expect(hasAdminPermission(handedUser(), 'settings:manage')).toBe(true);

    await expect(runWithUser({ adminRoleIds: [] })).rejects.toThrow(stop.message);
    expect(hasAdminPermission(handedUser(), 'settings:manage')).toBe(false);
  }, 120_000);

  it('grants nothing for a deleted or malformed role id', async () => {
    const { adminRoleRepository } = await import('@bike4mind/database');
    vi.mocked(adminRoleRepository.findByIds).mockResolvedValue([]);

    await expect(runWithUser({ adminRoleIds: [DELETED_ROLE_ID, 'not-an-id'] })).rejects.toThrow(stop.message);

    expect(adminRoleRepository.findByIds).toHaveBeenCalledWith([DELETED_ROLE_ID]);
    expect(hasAdminPermission(handedUser(), 'settings:manage')).toBe(false);
  }, 120_000);

  it('does not start the completion when the role lookup throws', async () => {
    const { adminRoleRepository } = await import('@bike4mind/database');
    vi.mocked(adminRoleRepository.findByIds).mockRejectedValue(new Error('db down'));

    await expect(runWithUser({ adminRoleIds: [ROLE_ID] })).rejects.toThrow('db down');

    expect(mockChatOptions).not.toHaveBeenCalled();
    expect(mockChatProcess).not.toHaveBeenCalled();
  }, 120_000);
});
