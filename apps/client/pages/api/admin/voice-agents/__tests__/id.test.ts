import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const { agentRepository, route } = vi.hoisted(() => ({
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
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, agentRepository }));
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
    agentRepository.findById.mockResolvedValue({ id: 'agent-1', type: 'voice', name: 'Aria' });
    agentRepository.update.mockResolvedValue(undefined);
  });

  const patch = (body: Record<string, unknown>) =>
    route.patch?.({ user: { isAdmin: true }, query: { id: 'agent-1' }, body, logger: { error: vi.fn() } }, makeRes());

  it('falls back to the existing name when Description is cleared', async () => {
    await patch({ description: '' });

    expect(agentRepository.update).toHaveBeenCalledWith({ id: 'agent-1', description: 'Aria' });
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
