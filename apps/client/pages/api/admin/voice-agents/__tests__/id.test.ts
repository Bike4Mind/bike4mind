import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequest } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const { adminAuditLogRepository, agentRepository, route } = vi.hoisted(() => ({
  adminAuditLogRepository: { append: vi.fn() },
  agentRepository: { findById: vi.fn(), update: vi.fn() },
  route: { patch: undefined as Handler | undefined },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: () => chain,
      delete: () => chain,
      patch: (handler: Handler) => {
        route.patch = handler;
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
  getSettingsValue: () => 'xi-test-key',
}));
vi.mock('@bike4mind/voice', () => ({
  deleteElevenLabsAgent: vi.fn(),
  getElevenLabsAgent: vi.fn(),
  updateElevenLabsAgent: vi.fn(),
}));

import '../[id]';

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('PATCH /api/admin/voice-agents/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminAuditLogRepository.append.mockResolvedValue(null);
    agentRepository.findById.mockResolvedValue({
      id: 'agent-1',
      type: 'voice',
      name: 'Aria',
      elevenLabsAgentId: 'el-agent-1',
    });
    agentRepository.update.mockResolvedValue(undefined);
  });

  const patch = (body: Record<string, unknown>) => {
    const req = createRequest({
      method: 'PATCH',
      url: '/api/admin/voice-agents/agent-1',
      query: { id: 'agent-1' },
      body,
    });
    Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger: { error: vi.fn() } });
    return route.patch?.(req, makeRes());
  };

  it('falls back to the existing name when Description is cleared', async () => {
    await patch({ description: '' });

    expect(agentRepository.update).toHaveBeenCalledWith({ id: 'agent-1', description: 'Aria' });
    expect(adminAuditLogRepository.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.voice_agent.updated',
        actor: expect.objectContaining({ userId: 'admin-1', wasAdmin: true }),
        target: { kind: 'settings', id: 'agent-1', displayName: 'Aria' },
        context: expect.objectContaining({ route: '/api/admin/voice-agents/agent-1' }),
      })
    );
  });

  it('falls back to the new name, not the stale one, when Description is cleared alongside a rename', async () => {
    await patch({ name: 'Nova', description: '' });

    expect(agentRepository.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Nova', description: 'Nova' }));
  });

  it('treats a whitespace-only Description as cleared', async () => {
    await patch({ description: '  ' });

    expect(agentRepository.update).toHaveBeenCalledWith({ id: 'agent-1', description: 'Aria' });
  });

  it('keeps a provided description', async () => {
    await patch({ description: 'Front desk' });

    expect(agentRepository.update).toHaveBeenCalledWith({ id: 'agent-1', description: 'Front desk' });
  });
});
