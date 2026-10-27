import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequest } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const { adminAuditLogRepository, agentRepository, createElevenLabsAgent, deleteElevenLabsAgent, route } = vi.hoisted(
  () => ({
    adminAuditLogRepository: { append: vi.fn() },
    agentRepository: { create: vi.fn(), listAllVoiceAgents: vi.fn() },
    createElevenLabsAgent: vi.fn(),
    deleteElevenLabsAgent: vi.fn(),
    route: { post: undefined as Handler | undefined },
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: () => chain,
      post: (handler: Handler) => {
        route.post = handler;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository, adminSettingsRepository: {}, agentRepository }));
vi.mock('@bike4mind/utils', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: (name: string) => (name === 'voiceV2Enabled' ? true : 'xi-test-key'),
}));
vi.mock('@bike4mind/voice', () => ({
  createElevenLabsAgent,
  deleteElevenLabsAgent,
  DEFAULT_TURN_EAGERNESS: 'normal',
  SILENCE_TURN_TIMEOUT_SECONDS: 7,
}));

import '../index';

const makeReq = (body: Record<string, unknown>) =>
  Object.assign(
    createRequest({
      method: 'POST',
      url: '/api/admin/voice-agents',
      headers: { host: 'example.test' },
      body: { name: 'Aria', voiceId: 'voice-1', systemPrompt: 'Be helpful', ...body },
    }),
    { user: { id: 'admin-1', isAdmin: true }, logger: { error: vi.fn(), warn: vi.fn() } }
  );

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/admin/voice-agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminAuditLogRepository.append.mockResolvedValue(null);
    agentRepository.listAllVoiceAgents.mockResolvedValue([]);
    createElevenLabsAgent.mockResolvedValue({ agentId: 'el-agent-1' });
    deleteElevenLabsAgent.mockResolvedValue(undefined);
  });

  it.each([
    ['omitted', {}],
    ['empty', { description: '' }],
    ['whitespace-only', { description: '   ' }],
  ])('persists a non-empty description when Description is %s', async (_label, body) => {
    agentRepository.create.mockResolvedValueOnce({ id: 'agent-1' });
    const res = makeRes();

    await route.post?.(makeReq(body), res);

    expect(agentRepository.create).toHaveBeenCalledWith(expect.objectContaining({ description: 'Aria' }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(deleteElevenLabsAgent).not.toHaveBeenCalled();
    expect(adminAuditLogRepository.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.voice_agent.created',
        actor: expect.objectContaining({ userId: 'admin-1', wasAdmin: true }),
        target: { kind: 'settings', id: 'agent-1', displayName: 'Aria' },
        context: expect.objectContaining({ route: '/api/admin/voice-agents' }),
      })
    );
  });

  it('keeps a provided description', async () => {
    agentRepository.create.mockResolvedValueOnce({ id: 'agent-1' });

    await route.post?.(makeReq({ description: 'Front desk' }), makeRes());

    expect(agentRepository.create).toHaveBeenCalledWith(expect.objectContaining({ description: 'Front desk' }));
  });

  it('deletes the ElevenLabs agent and rethrows when the save fails', async () => {
    agentRepository.create.mockRejectedValueOnce(new Error('save failed'));

    await expect(route.post?.(makeReq({}), makeRes())).rejects.toThrow('save failed');

    expect(deleteElevenLabsAgent).toHaveBeenCalledExactlyOnceWith('xi-test-key', 'el-agent-1');
  });

  it('still reports the save failure when the rollback delete also fails', async () => {
    agentRepository.create.mockRejectedValueOnce(new Error('save failed'));
    deleteElevenLabsAgent.mockRejectedValueOnce(new Error('delete failed'));
    const req = makeReq({});

    await expect(route.post?.(req, makeRes())).rejects.toThrow('save failed');

    expect(req.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { err: expect.objectContaining({ message: 'delete failed' }), agentId: 'el-agent-1' },
      expect.stringContaining('agent is orphaned')
    );
  });
});
