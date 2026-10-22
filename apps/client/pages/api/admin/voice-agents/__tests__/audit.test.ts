// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  listAllVoiceAgents: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setDefaultVoiceAgent: vi.fn(),
  createElevenLabsAgent: vi.fn(),
  updateElevenLabsAgent: vi.fn(),
  deleteElevenLabsAgent: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const on = (method: string) => (fn: (req: unknown, res: unknown) => unknown) => ((routes[method] = fn), chain);
    const chain: Record<string, unknown> = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res),
      {
        get: on('GET'),
        post: on('POST'),
        patch: on('PATCH'),
        delete: on('DELETE'),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentRepository: {
    listAllVoiceAgents: h.listAllVoiceAgents,
    create: h.create,
    findById: h.findById,
    update: h.update,
    delete: h.remove,
    setDefaultVoiceAgent: h.setDefaultVoiceAgent,
  },
}));
vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'voiceV2Enabled' ? true : 'server-key'),
}));
vi.mock('@bike4mind/voice', () => ({
  DEFAULT_TURN_EAGERNESS: 'normal',
  SILENCE_TURN_TIMEOUT_SECONDS: 7,
  createElevenLabsAgent: h.createElevenLabsAgent,
  updateElevenLabsAgent: h.updateElevenLabsAgent,
  deleteElevenLabsAgent: h.deleteElevenLabsAgent,
  getElevenLabsAgent: vi.fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import collectionHandler from '../index';
import itemHandler from '../[id]';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = async (
  handler: unknown,
  method: 'POST' | 'PATCH' | 'DELETE',
  options: { body?: object; query?: Record<string, string> }
) => {
  const { req, res } = createMocks({
    method,
    body: options.body,
    query: options.query,
    headers: { host: 'app.example.com' },
  });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger: { error: vi.fn(), warn: vi.fn() } });
  await (handler as Handler)(req, res);
  return { req, res };
};

const existingAgent = {
  id: 'agent-1',
  name: 'Concierge',
  type: 'voice',
  elevenLabsAgentId: 'el-1',
  isDefaultVoiceAgent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue(existingAgent);
});

describe('/api/admin/voice-agents admin audit', () => {
  it('POST records voice_agent.created after the agent is stored', async () => {
    h.listAllVoiceAgents.mockResolvedValue([]);
    h.createElevenLabsAgent.mockResolvedValue({ agentId: 'el-9' });
    h.create.mockResolvedValue({ id: 'agent-9', name: 'Concierge' });
    const { req, res } = await run(collectionHandler, 'POST', {
      body: { name: 'Concierge', voiceId: 'voice-1', systemPrompt: 'Be helpful and kind' },
    });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.voice_agent.created',
      target: { kind: 'settings', id: 'agent-9', displayName: 'Concierge' },
      details: { elevenLabsAgentId: 'el-9', isDefault: true },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('Be helpful');
  });

  it('POST records nothing when ElevenLabs rejects the agent', async () => {
    h.listAllVoiceAgents.mockResolvedValue([]);
    h.createElevenLabsAgent.mockRejectedValue(new Error('upstream down'));
    const { res } = await run(collectionHandler, 'POST', {
      body: { name: 'Concierge', voiceId: 'voice-1', systemPrompt: 'Be helpful and kind' },
    });

    expect(res._getStatusCode()).toBe(502);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('PATCH records voice_agent.updated with field names but not the prompt text', async () => {
    h.updateElevenLabsAgent.mockResolvedValue(undefined);
    await run(itemHandler, 'PATCH', {
      query: { id: 'agent-1' },
      body: { systemPrompt: 'Brand new secret-ish prompt' },
    });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.voice_agent.updated',
      target: { kind: 'settings', id: 'agent-1', displayName: 'Concierge' },
      details: { fields: ['systemPrompt'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('Brand new');
  });

  it('DELETE records voice_agent.deleted after the agent is removed', async () => {
    h.listAllVoiceAgents.mockResolvedValue([]);
    const { res } = await run(itemHandler, 'DELETE', { query: { id: 'agent-1' } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.remove).toHaveBeenCalledWith('agent-1');
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.voice_agent.deleted',
      target: { kind: 'settings', id: 'agent-1', displayName: 'Concierge' },
      details: { elevenLabsAgentId: 'el-1', wasDefault: true },
    });
  });
});
