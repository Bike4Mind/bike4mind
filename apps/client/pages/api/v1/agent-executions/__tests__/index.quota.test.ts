// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, ORG_TOOL_NOT_ALLOWED_ERROR_CODE, TooManyRequestsError } from '@bike4mind/common';

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
// Passthrough: the free-tier default fallback has its own tests (server/utils/callerModelList.test.ts).
vi.mock('@server/utils/callerModelList', () => ({
  resolveCallerDefaultModel: (...a: unknown[]) => mockResolveCallerDefaultModel(...a),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: async () => ({}), getSettingsValue: () => 'claude-opus-5' }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
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

  it('forwards the verified credential to the shared quota gate without checking twice', async () => {
    const req = request();
    const res = response();
    await captured.handler!(req, res);
    expect(mockStartAgentExecution).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyInfo: req.apiKeyInfo }),
      req.logger
    );
    expect(mockAdmitRequestCompletion).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('starts a model-less run on the caller-specific default model', async () => {
    mockResolveDefaultChatModel.mockResolvedValueOnce({ model: 'admin-default' });
    mockResolveCallerDefaultModel.mockResolvedValueOnce('allowlisted-model');
    const req = request();
    req.validated = { session_id: 's1', message: 'hi' } as typeof req.validated;
    await captured.handler!(req, response());
    expect(mockResolveCallerDefaultModel).toHaveBeenCalledWith('admin-default', req.user, req.logger, {
      organizationId: null,
    });
    expect(mockStartAgentExecution).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'allowlisted-model' }),
      req.logger
    );
  });

  it('resolves a model-less default under the org the run bills: the key org, else the body org', async () => {
    mockResolveDefaultChatModel.mockResolvedValue({ model: 'admin-default' });
    const named = request();
    named.validated = { session_id: 's1', message: 'hi', organization_id: 'body-org' } as typeof named.validated;
    await captured.handler!(named, response());
    expect(mockResolveCallerDefaultModel).toHaveBeenLastCalledWith('admin-default', named.user, named.logger, {
      organizationId: 'body-org',
    });

    const orgKey = request();
    orgKey.apiKeyInfo = {
      keyId: 'k1',
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'key-org',
    } as typeof orgKey.apiKeyInfo;
    orgKey.validated = { session_id: 's1', message: 'hi', organization_id: 'body-org' } as typeof orgKey.validated;
    await captured.handler!(orgKey, response());
    expect(mockResolveCallerDefaultModel).toHaveBeenLastCalledWith('admin-default', orgKey.user, orgKey.logger, {
      organizationId: 'key-org',
    });
  });

  it('maps an org tool refusal to 403 org_tool_not_allowed without accepting the run', async () => {
    mockStartAgentExecution.mockResolvedValue({
      ok: false,
      reason: 'org_tool_not_allowed',
      message: 'Tools not allowed by your organization: web_search',
    });
    const res = response();
    await expect(captured.handler!(request(), res)).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: ORG_TOOL_NOT_ALLOWED_ERROR_CODE },
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('propagates shared quota refusal without accepting the run', async () => {
    mockStartAgentExecution.mockRejectedValue(
      new TooManyRequestsError('Token rate limit exceeded', { errorCode: 'token_rate_limit_exceeded', retryAfter: 3 })
    );
    const res = response();
    await expect(captured.handler!(request(), res)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockStartAgentExecution).toHaveBeenCalledOnce();
  });
});
