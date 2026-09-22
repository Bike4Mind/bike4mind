/**
 * Same #3084 bug class as configs.ts, but this route queues real side effects (proactive-message
 * sends), so it's gated at write level: any owner or update-permission sharee may trigger it, a
 * read-only share may not, and a non-share gets 404 (never the old 401 that force-logs a caller out).
 *
 * Also pins that only the CALLER's OWN configs get queued: this endpoint bypasses the cron path's
 * activeHours/minIntervalHours eligibility gates entirely, so without an ownership filter a write
 * sharee could force another user's (e.g. the owner's) config to fire on demand and spend that
 * user's LLM keys/credits - a session-level write grant must not translate into that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/utils';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  findById: vi.fn(),
  findBySessionId: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...args: unknown[]) => mockRefs.findById(...args) },
  sessionAgentConfigRepository: { findBySessionId: (...args: unknown[]) => mockRefs.findBySessionId(...args) },
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...args: unknown[]) => mockRefs.sendToQueue(...args) }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue-url' }));

// Import after mocks so the chain captures the handler; exercises the real assertSessionAccess.
import '../trigger-proactive-messages';

function invoke(userId: string) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
  (req as any).user = { id: userId, groups: [] };
  (req as any).logger = { info: vi.fn(), error: vi.fn() };
  return { req: req as any, res: res as any };
}

describe('POST /api/sessions/[id]/agents/trigger-proactive-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.sendToQueue.mockResolvedValue(undefined);
  });

  it("queues the owner's own enabled config", async () => {
    mockRefs.findById.mockResolvedValue({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] });
    mockRefs.findBySessionId.mockResolvedValue([
      { id: 'cfg-1', agentId: 'agent-1', userId: 'owner', proactiveMessaging: { enabled: true } },
    ]);
    const { req, res } = invoke('owner');

    await mockRefs.postHandler!(req, res);

    expect(mockRefs.sendToQueue).toHaveBeenCalledWith('queue-url', { sessionAgentConfigId: 'cfg-1' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, triggeredCount: 1, totalEnabledAgents: 1 });
  });

  it('lets an update-permission sharee trigger their OWN config', async () => {
    mockRefs.findById.mockResolvedValue({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'owner',
      users: [{ userId: 'editor', permissions: ['read', 'update'] }],
    });
    mockRefs.findBySessionId.mockResolvedValue([
      { id: 'cfg-2', agentId: 'agent-2', userId: 'editor', proactiveMessaging: { enabled: true } },
    ]);
    const { req, res } = invoke('editor');

    await mockRefs.postHandler!(req, res);

    expect(mockRefs.sendToQueue).toHaveBeenCalledWith('queue-url', { sessionAgentConfigId: 'cfg-2' });
    expect(res._getJSONData()).toMatchObject({ success: true, triggeredCount: 1, totalEnabledAgents: 1 });
  });

  it("does NOT let a write sharee trigger the OWNER's config - only their own", async () => {
    mockRefs.findById.mockResolvedValue({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'owner',
      users: [{ userId: 'editor', permissions: ['read', 'update'] }],
    });
    mockRefs.findBySessionId.mockResolvedValue([
      { id: 'cfg-owner', agentId: 'agent-1', userId: 'owner', proactiveMessaging: { enabled: true } },
    ]);
    const { req, res } = invoke('editor');

    await mockRefs.postHandler!(req, res);

    expect(mockRefs.sendToQueue).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ success: true, triggeredCount: 0, totalEnabledAgents: 0 });
  });

  it('404s a read-only sharee (write-level action, not a read)', async () => {
    mockRefs.findById.mockResolvedValue({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'owner',
      users: [{ userId: 'viewer', permissions: ['read'] }],
    });
    const { req, res } = invoke('viewer');

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(NotFoundError);
    expect(mockRefs.findBySessionId).not.toHaveBeenCalled();
  });

  it('404s (not 401s) a caller with no share on the session', async () => {
    mockRefs.findById.mockResolvedValue({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] });
    const { req, res } = invoke('stranger');

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(NotFoundError);
  });
});
