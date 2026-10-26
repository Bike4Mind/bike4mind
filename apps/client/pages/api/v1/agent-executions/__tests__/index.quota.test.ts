// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const { captured, mockAdmitRequestCompletion, mockStartAgentExecution } = vi.hoisted(() => ({
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
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => 'limiter' }));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: vi.fn() }));
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  isChatModelUsable: vi.fn(),
  resolveDefaultChatModel: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@server/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@server/utils/startAgentExecution', () => ({
  startAgentExecution: (...a: unknown[]) => mockStartAgentExecution(...a),
}));
vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: (...a: unknown[]) => mockAdmitRequestCompletion(...a),
}));

import '../index';

const request = () => ({
  user: { id: 'u1' },
  apiKeyInfo: { keyId: 'k1' },
  validated: { session_id: 's1', message: 'hi', model: 'test-model' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/v1/agent-executions - untrusted owner quotas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdmitRequestCompletion.mockResolvedValue({ release: vi.fn() });
    mockStartAgentExecution.mockResolvedValue({ ok: true, executionId: 'exec-1' });
  });

  it('checks the token quota for the queued run without holding a concurrency slot', async () => {
    const req = request();
    const res = response();
    await captured.handler!(req, res);
    expect(mockAdmitRequestCompletion).toHaveBeenCalledWith(req, { holdSlot: false });
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('refuses an over-quota run before starting it', async () => {
    mockAdmitRequestCompletion.mockRejectedValue(
      new TooManyRequestsError('Token rate limit exceeded', { errorCode: 'token_rate_limit_exceeded', retryAfter: 3 })
    );
    await expect(captured.handler!(request(), response())).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mockStartAgentExecution).not.toHaveBeenCalled();
  });
});
