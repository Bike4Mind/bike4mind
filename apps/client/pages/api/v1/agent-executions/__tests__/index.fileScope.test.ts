// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const {
  captured,
  mockAdmitRequestCompletion,
  mockStartAgentExecution,
  mockResolveDefaultChatModel,
  mockResolveCallerDefaultModel,
} = vi.hoisted(() => ({
  mockResolveDefaultChatModel: vi.fn(),
  mockResolveCallerDefaultModel: vi.fn(async (model: string) => model),
  captured: {} as { handler?: Handler },
  mockAdmitRequestCompletion: vi.fn(),
  mockStartAgentExecution: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({
    post: (handler: Handler) => {
      captured.handler = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => 'limiter' }));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/chatCompletionDefaults', () => ({
  isChatModelUsable: vi.fn(),
  resolveDefaultChatModel: (...a: unknown[]) => mockResolveDefaultChatModel(...a),
}));
vi.mock('@server/utils/callerModelList', () => ({
  resolveCallerDefaultModel: (...a: unknown[]) => mockResolveCallerDefaultModel(...a),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: async () => ({}), getSettingsValue: () => 'claude-opus-5' }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@server/utils/startAgentExecution', () => ({
  startAgentExecution: (...a: unknown[]) => mockStartAgentExecution(...a),
}));
vi.mock('@bike4mind/server-utils/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: (...a: unknown[]) => mockAdmitRequestCompletion(...a),
}));

import '../index';

const request = (scopes: string[] | null, files: Record<string, string[]>) => ({
  user: { id: 'u1' },
  ...(scopes && { apiKeyInfo: { keyId: 'k1', scopes } }),
  validated: { session_id: 's1', message: 'hi', model: 'test-model', ...files },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/v1/agent-executions - attached files need files:read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartAgentExecution.mockResolvedValue({ ok: true, executionId: 'exec-1' });
  });

  it.each([{ file_ids: ['f1'] }, { session_file_ids: ['f1'] }])(
    'refuses an ai:chat key that attaches %o and starts nothing',
    async files => {
      await expect(captured.handler!(request(['ai:chat'], files), response())).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(mockStartAgentExecution).not.toHaveBeenCalled();
    }
  );

  it('starts the run for a key holding files:read, a session caller, and a key attaching nothing', async () => {
    await captured.handler!(request(['ai:chat', 'files:read'], { file_ids: ['f1'] }), response());
    await captured.handler!(request(null, { file_ids: ['f1'] }), response());
    await captured.handler!(request(['ai:chat'], { file_ids: [] }), response());
    expect(mockStartAgentExecution).toHaveBeenCalledTimes(3);
  });
});
