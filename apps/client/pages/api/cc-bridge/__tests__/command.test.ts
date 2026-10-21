import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRoute, tavernUser, type RouteHandler } from './testUtils';

const refs = vi.hoisted(() => ({
  post: null as null | RouteHandler,
  rateLimitOpts: null as null | { limit: number; windowMs: number },
  findAgent: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: RouteHandler) => {
      refs.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (opts: { limit: number; windowMs: number }) => {
    refs.rateLimitOpts = opts;
    return () => undefined;
  },
}));
vi.mock('@bike4mind/database', () => ({ activeCodeAgentRepository: { findByInstanceIdForUser: refs.findAgent } }));
vi.mock('@server/websocket/utils', () => ({ sendToConnection: refs.send }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.test' } } }));

import '../command';

const agent = (over: Record<string, unknown> = {}) => ({
  instanceId: 'inst-1',
  userId: 'user-1',
  connectionId: 'conn-1',
  source: 'bridge',
  capabilities: ['interactive'],
  ...over,
});

const send = (opts: Parameters<typeof mockRoute>[0]) => {
  const { req, res } = mockRoute(opts);
  return { res, run: () => refs.post!(req, res) };
};

const body = { instanceId: 'inst-1', command: { type: 'send_prompt', text: 'hello' } };

describe('POST /api/cc-bridge/command', () => {
  beforeEach(() => {
    refs.findAgent.mockReset().mockResolvedValue(agent());
    refs.send.mockReset().mockResolvedValue(undefined);
  });

  it('is rate limited per user and path', () => {
    expect(refs.rateLimitOpts).toEqual({ limit: 60, windowMs: 60_000 });
  });

  it('rejects an unauthenticated request without any lookup or dispatch', async () => {
    const { run } = send({ user: null, body });
    await expect(run()).rejects.toThrow(/authenticated user/i);
    expect(refs.findAgent).not.toHaveBeenCalled();
    expect(refs.send).not.toHaveBeenCalled();
  });

  it('rejects a user without tavern access', async () => {
    const { run } = send({ user: { id: 'user-1', isAdmin: false, tags: [] }, body });
    await expect(run()).rejects.toThrow(/tavern access/i);
    expect(refs.send).not.toHaveBeenCalled();
  });

  it('dispatches a prompt to the owned agent connection and returns a requestId', async () => {
    const { res, run } = send({ user: tavernUser, body });
    await run();

    expect(res._getStatusCode()).toBe(200);
    const { ok, requestId } = res._getJSONData();
    expect(ok).toBe(true);
    expect(refs.findAgent).toHaveBeenCalledWith('inst-1', 'user-1');
    expect(refs.send).toHaveBeenCalledWith('conn-1', 'https://ws.example.test', {
      action: 'cc_agent_command',
      instanceId: 'inst-1',
      requestId,
      command: { type: 'send_prompt', text: 'hello' },
    });
  });

  it.each([
    ['resolve_permission', { type: 'resolve_permission', requestId: 'r-1', allow: false }],
    ['abort', { type: 'abort' }],
  ])('dispatches a %s command', async (_name, command) => {
    const { res, run } = send({ user: tavernUser, body: { instanceId: 'inst-1', command } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(refs.send.mock.calls[0][2].command).toEqual(command);
  });

  it("cannot command another user's agent: lookup is scoped to the caller and a miss is a 404", async () => {
    refs.findAgent.mockResolvedValue(null);
    const { run } = send({ user: tavernUser, body });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(refs.findAgent).toHaveBeenCalledWith('inst-1', 'user-1');
    expect(refs.send).not.toHaveBeenCalled();
  });

  it('ignores a userId supplied in the body when scoping the lookup', async () => {
    const { run } = send({ user: tavernUser, body: { ...body, userId: 'victim-1' } });
    await run();
    expect(refs.findAgent).toHaveBeenCalledWith('inst-1', 'user-1');
  });

  it('refuses commands to a read-only agent', async () => {
    refs.findAgent.mockResolvedValue(agent({ capabilities: ['observe'] }));
    const { run } = send({ user: tavernUser, body });
    await expect(run()).rejects.toThrow(/read-only/i);
    expect(refs.send).not.toHaveBeenCalled();
  });

  it('answers 503 when the bridge connection has dropped', async () => {
    refs.send.mockRejectedValue(new Error('GoneException'));
    const { res, run } = send({ user: tavernUser, body });
    await run();
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().ok).toBe(false);
  });

  it.each([
    ['no body', undefined],
    ['a missing instanceId', { command: { type: 'abort' } }],
    ['an empty instanceId', { instanceId: '', command: { type: 'abort' } }],
    ['an oversized instanceId', { instanceId: 'i'.repeat(129), command: { type: 'abort' } }],
    ['a missing command', { instanceId: 'inst-1' }],
    ['an unknown command type', { instanceId: 'inst-1', command: { type: 'shell', text: 'rm -rf /' } }],
    ['an empty prompt', { instanceId: 'inst-1', command: { type: 'send_prompt', text: '' } }],
    ['an oversized prompt', { instanceId: 'inst-1', command: { type: 'send_prompt', text: 'x'.repeat(4001) } }],
    [
      'a non-boolean allow',
      { instanceId: 'inst-1', command: { type: 'resolve_permission', requestId: 'r', allow: 'yes' } },
    ],
    ['an object instanceId', { instanceId: { $ne: '' }, command: { type: 'abort' } }],
  ])('rejects %s before any lookup or dispatch', async (_name, payload) => {
    const { run } = send({ user: tavernUser, body: payload });
    await expect(run()).rejects.toThrow(/invalid command/i);
    expect(refs.findAgent).not.toHaveBeenCalled();
    expect(refs.send).not.toHaveBeenCalled();
  });
});
