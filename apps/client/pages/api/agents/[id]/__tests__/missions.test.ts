import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  postHandler: null as null | Handler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const agentFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ agentRepository: { findById: agentFindById } }));

const enrollMissionForAgent = vi.hoisted(() => vi.fn());
const listMissionsForAgent = vi.hoisted(() => vi.fn());
vi.mock('@server/deepAgent/missions', () => ({ enrollMissionForAgent, listMissionsForAgent }));
vi.mock('@server/deepAgent/store', () => ({ MongoDeepAgentStore: class MongoDeepAgentStore {} }));
const runMissionFirstWake = vi.hoisted(() => vi.fn());
vi.mock('@server/deepAgent/firstWake', () => ({ runMissionFirstWake }));

const assertAgentsReadScope = vi.hoisted(() => vi.fn());
const assertAgentsWriteScope = vi.hoisted(() => vi.fn());
vi.mock('@server/agents/agentScopes', () => ({
  AGENTS_READ_OR_WRITE_SCOPES: [],
  assertAgentsReadScope,
  assertAgentsWriteScope,
}));

import '@pages/api/agents/[id]/missions';

const SHARED_AGENT = { id: 'a1', userId: 'owner', users: [{ userId: 'u1' }] };
const OWNED_AGENT = { id: 'a1', userId: 'u1', users: [] };
const NOT_FOUND_BODY = { error: 'Agent not found' };

function invoke(method: 'GET' | 'POST', user: Record<string, unknown>, query: Record<string, unknown> = { id: 'a1' }) {
  const { req, res } = createMocks({ method, query, body: { goal: 'ship it' } });
  Object.assign(req, { user });
  const handler = method === 'GET' ? mockRefs.getHandler! : mockRefs.postHandler!;
  return { req, res, run: () => handler(req, res) };
}

const developer = { id: 'u1', isAdmin: false, tags: ['developer'] };

describe('GET /api/agents/[id]/missions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMissionsForAgent.mockResolvedValue([]);
  });

  it('asserts the agents:read scope with the request', async () => {
    agentFindById.mockResolvedValue(OWNED_AGENT);
    const { req, run } = invoke('GET', developer);
    await run();
    expect(assertAgentsReadScope).toHaveBeenCalledWith(req);
  });

  it('answers a stranger and a missing id with the same status and body', async () => {
    agentFindById.mockResolvedValueOnce(SHARED_AGENT);
    const stranger = invoke('GET', { id: 'stranger', isAdmin: false });
    await stranger.run();

    agentFindById.mockResolvedValueOnce(null);
    const missing = invoke('GET', { id: 'stranger', isAdmin: false });
    await missing.run();

    expect(stranger.res._getStatusCode()).toBe(404);
    expect(missing.res._getStatusCode()).toBe(404);
    expect(stranger.res._getJSONData()).toEqual(NOT_FOUND_BODY);
    expect(stranger.res._getData()).toBe(missing.res._getData());
    expect(listMissionsForAgent).not.toHaveBeenCalled();
  });

  it('lets a user the agent is shared with read the roster', async () => {
    agentFindById.mockResolvedValue(SHARED_AGENT);
    const { res, run } = invoke('GET', developer);
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(listMissionsForAgent).toHaveBeenCalledWith('a1');
  });

  it('lets an admin read any existing agent but still 404s a missing one', async () => {
    agentFindById.mockResolvedValueOnce(SHARED_AGENT);
    const existing = invoke('GET', { id: 'admin', isAdmin: true });
    await existing.run();
    expect(existing.res._getStatusCode()).toBe(200);

    agentFindById.mockResolvedValueOnce(null);
    const missing = invoke('GET', { id: 'admin', isAdmin: true });
    await missing.run();
    expect(missing.res._getStatusCode()).toBe(404);
    expect(missing.res._getJSONData()).toEqual(NOT_FOUND_BODY);
  });
});

describe('POST /api/agents/[id]/missions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFindById.mockResolvedValue(OWNED_AGENT);
  });

  it('asserts the agents:write scope with the request', async () => {
    enrollMissionForAgent.mockRejectedValue(new Error('no agent x'));
    const { req, run } = invoke('POST', developer);
    await run();
    expect(assertAgentsWriteScope).toHaveBeenCalledWith(req);
  });

  it.each(['not your agent', 'no agent x'])('maps an enroll failure "%s" to the generic 404', async message => {
    enrollMissionForAgent.mockRejectedValue(new Error(message));
    const { res, run } = invoke('POST', developer);
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual(NOT_FOUND_BODY);
  });

  it('answers an unrelated enroll failure with a 500', async () => {
    enrollMissionForAgent.mockRejectedValue(new Error('database exploded'));
    const { res, run } = invoke('POST', developer);
    await run();
    expect(res._getStatusCode()).toBe(500);
  });

  it('rejects a shared viewer with 403 before enrolling', async () => {
    agentFindById.mockResolvedValue(SHARED_AGENT);
    const { res, run } = invoke('POST', developer);
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(enrollMissionForAgent).not.toHaveBeenCalled();
  });

  it('answers a stranger and a missing agent with the same 404 before enrolling', async () => {
    agentFindById.mockResolvedValueOnce(SHARED_AGENT);
    const stranger = invoke('POST', { id: 'stranger', isAdmin: false, tags: ['developer'] });
    await stranger.run();

    agentFindById.mockResolvedValueOnce(null);
    const missing = invoke('POST', { id: 'stranger', isAdmin: false, tags: ['developer'] });
    await missing.run();

    expect(stranger.res._getStatusCode()).toBe(404);
    expect(stranger.res._getData()).toBe(missing.res._getData());
    expect(stranger.res._getJSONData()).toEqual(NOT_FOUND_BODY);
    expect(enrollMissionForAgent).not.toHaveBeenCalled();
  });

  it('answers an admin with a missing agent with 404 before enrolling', async () => {
    agentFindById.mockResolvedValue(null);
    const { res, run } = invoke('POST', { id: 'admin', isAdmin: true });
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(enrollMissionForAgent).not.toHaveBeenCalled();
  });
});
