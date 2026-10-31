import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import type { Request, Response } from 'express';

type Handler = (request: Request, response: Response) => Promise<unknown>;
const quota = vi.hoisted(() => ({ admit: vi.fn() }));
const reserveRequestCredits = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: quota.admit }));
vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits }));

// Keep each route's real completion wrapper. The router only captures its registered handler;
// quota rejection must prevent entering the handler at all, even with no body/query supplied.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const router = { use: () => router, post: (handler: Handler) => handler };
    return router;
  },
}));
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({ post: (handler: Handler) => handler }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  agentOpsSettingsRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
  fabFileRepository: {},
  userRepository: {},
  organizationRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: {},
  FabFile: {},
  withTransaction: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {}, fabFilesService: {}, recordOperationalUsage: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({ OperationsModelService: {} }));
vi.mock('@server/agents/assertAgentAccess', () => ({ assertAgentAccess: vi.fn() }));
vi.mock('@client/server/agents/systemPromptRateLimit', () => ({ assertSystemPromptGenerationAllowed: vi.fn() }));
vi.mock('@server/moderation/imageModerationIncidents', () => ({ imageModerationIncidents: {} }));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@server/help/retrieval', () => ({ searchHelpContext: vi.fn() }));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  blockedAtZeroTierLimit: () => async () => 20,
  perUserRateLimit: vi.fn(),
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  completionRequestCeilingUsd: vi.fn(),
  completionUsd: vi.fn(),
  createModelAdmission: vi.fn(),
  hasReportedUsage: vi.fn(),
  latchUsage: vi.fn(),
  reserveCompletionCredits: vi.fn(),
  settleCompletion: vi.fn(),
}));

const routes = [
  ['agent field enhancement', () => import('../agents/[id]/enhance-field')],
  ['agent avatar generation', () => import('../agents/[id]/generate-avatar')],
  ['agent description generation', () => import('../agents/[id]/generate-description')],
  ['agent system prompt generation', () => import('../agents/[id]/generate-system-prompt')],
  ['v1 agent field enhancement', () => import('../v1/agents/[id]/enhance-field')],
  ['v1 agent avatar generation', () => import('../v1/agents/[id]/generate-avatar')],
  ['v1 agent description generation', () => import('../v1/agents/[id]/generate-description')],
  ['v1 agent system prompt generation', () => import('../v1/agents/[id]/generate-system-prompt')],
  ['fabfile editing', () => import('../fabfiles/[id]/edit')],
  ['help chat', () => import('../help/chat')],
  ['lattice chat', () => import('../lattice/chat')],
] as const;

describe('utility completion quota admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(routes)('refuses %s before model or storage work begins', async (_name, loadRoute) => {
    const { default: registeredHandler } = await loadRoute();
    const handler = registeredHandler as unknown as Handler;
    const error = new Error('completion quota exhausted');
    quota.admit.mockRejectedValueOnce(error);
    const request = { user: { id: 'untrusted-owner' }, apiKeyInfo: { ownerUntrusted: true } } as unknown as Request;
    const response = {} as Response;

    await expect(handler(request, response)).rejects.toBe(error);
    expect(quota.admit).toHaveBeenCalledExactlyOnceWith(request, { holdSlot: true });
    expect(reserveRequestCredits).not.toHaveBeenCalled();
  });
});
