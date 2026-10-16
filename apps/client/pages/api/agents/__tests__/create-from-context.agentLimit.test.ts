import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';

/**
 * create-from-context writes a project and an agent itself instead of going through createAgent,
 * so it must apply the same per-tier cap (assertAgentLimit) before either write.
 */
const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  countByUserId: vi.fn(),
  agentCreate: vi.fn(),
  projectCreate: vi.fn(),
  findAllBySessionId: vi.fn(),
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
  sessionRepository: { findById: vi.fn().mockResolvedValue({ id: 'sess-1', userId: 'user-1' }) },
  questRepository: { findAllBySessionId: h.findAllBySessionId },
  agentOpsSettingsRepository: { getSettings: vi.fn().mockResolvedValue(null) },
  fabFileRepository: {},
  agentRepository: { countByUserId: h.countByUserId, create: h.agentCreate },
  projectRepository: { create: h.projectCreate },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  withTransaction: vi.fn(),
}));

vi.mock('@server/dataLakes/attachmentLakeAccess', () => ({ createAttachmentLakeAccess: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: vi.fn(), getLlmByModel: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {}, creditService: {}, meterCompletionBackend: vi.fn() }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ createRequestCompletionMeter: vi.fn() }));

await import('../create-from-context');

// Stops an admitted request at the first read inside the generation path.
const STOP = new Error('stop after admission');

function fire(level: string) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const req = {
    body: { agentName: 'Helper', sessionId: '67dbe18a7f9cf1fa5d9686aa' },
    user: { id: 'user-1', level },
    logger,
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return { req, res, run: () => h.handler!(req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findAllBySessionId.mockRejectedValue(STOP);
});

describe('POST /api/agents/create-from-context - agent tier cap', () => {
  it('400s a user at the cap with agent_limit_reached and writes no project or agent', async () => {
    h.countByUserId.mockResolvedValue(2);

    const error = await fire('DemoUser')
      .run()
      .catch(e => e);

    expect(error).toMatchObject({
      name: 'BadRequestError',
      statusCode: 400,
      additionalInfo: { errorCode: AGENT_LIMIT_REACHED_ERROR_CODE },
    });
    expect(h.countByUserId).toHaveBeenCalledWith('user-1');
    expect(h.findAllBySessionId).not.toHaveBeenCalled();
    expect(h.projectCreate).not.toHaveBeenCalled();
    expect(h.agentCreate).not.toHaveBeenCalled();
  });

  it('lets a user under the cap proceed', async () => {
    h.countByUserId.mockResolvedValue(1);

    await fire('DemoUser').run();

    expect(h.findAllBySessionId).toHaveBeenCalledWith('67dbe18a7f9cf1fa5d9686aa');
  });
});
