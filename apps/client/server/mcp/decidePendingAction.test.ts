// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';

vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  Session: { findById: vi.fn() },
  Quest: { findById: vi.fn() },
  fabFileRepository: { shareable: { findAccessibleById: vi.fn() } },
}));
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpAccess', () => ({ assertCustomMcpEnabled: vi.fn() }));
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpToolHost', () => ({
  customMcpToolHost: { callTool: vi.fn() },
  isCustomToolStillOffered: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/pendingActionExecutor', () => ({ claimPendingAction: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/github/github-repo-helper', () => ({
  getSelectedRepositoriesForMcp: vi.fn(),
}));
vi.mock('@bike4mind/slack', () => {
  class StubResource {
    getMcpEnvVariables = vi.fn().mockResolvedValue([]);
  }
  return { GitHubResource: StubResource, JiraResource: StubResource, ConfluenceResource: StubResource };
});

import { Quest, Session } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { invokeMcpHandler } from '@bike4mind/server-utils/utils/invokeMcpHandler';
import { claimPendingAction } from '@bike4mind/server-utils/utils/pendingActionExecutor';
import { getSelectedRepositoriesForMcp } from '@bike4mind/server-utils/integrations/github/github-repo-helper';
import { decidePendingAction } from './decidePendingAction';

const SESSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const QUEST_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const EXPIRY_MS = 15 * 60 * 1000;

type Decision = Parameters<typeof decidePendingAction>[0];
const logger = new Logger({ metadata: { component: 'test' } });

function decide(overrides: Partial<Decision> = {}) {
  return decidePendingAction({
    user: { id: 'user-1' } as Decision['user'],
    questId: QUEST_ID,
    pendingActionTs: pendingActionTs,
    confirmed: true,
    logger,
    ...overrides,
  });
}

let pendingActionTs: number;

describe('decidePendingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingActionTs = Date.now();
    vi.mocked(Session.findById).mockResolvedValue({ userId: 'user-1' } as never);
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'create_issue', params: { owner: 'o', repo: 'r', title: 't' }, ts: pendingActionTs },
    } as never);
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['o/r']);
    vi.mocked(claimPendingAction).mockResolvedValue(true);
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [{ text: JSON.stringify({ url: 'https://example.test/x', number: 7 }) }],
    } as never);
  });

  it('approves: claims the action once and runs the tool', async () => {
    const result = await decide();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, url: 'https://example.test/x' });
    expect(claimPendingAction).toHaveBeenCalledTimes(1);
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);
  });

  it('denies: clears the action and never runs the tool', async () => {
    const result = await decide({ confirmed: false });

    expect(result).toEqual({ status: 200, body: { success: true, message: 'Action cancelled' } });
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('answers 404 for a session owned by another user, and acts on nothing', async () => {
    vi.mocked(Session.findById).mockResolvedValue({ userId: 'someone-else' } as never);

    await expect(decide()).rejects.toBeInstanceOf(NotFoundError);
    await expect(decide({ confirmed: false })).rejects.toBeInstanceOf(NotFoundError);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or malformed quest id', async () => {
    vi.mocked(Quest.findById).mockResolvedValue(null as never);
    await expect(decide()).rejects.toBeInstanceOf(NotFoundError);
    await expect(decide({ questId: 'not-an-object-id' })).rejects.toBeInstanceOf(NotFoundError);
    expect(claimPendingAction).not.toHaveBeenCalled();
  });

  it('refuses a stale action replaced by a newer one, for approve and deny alike', async () => {
    for (const confirmed of [true, false]) {
      const result = await decide({ confirmed, pendingActionTs: pendingActionTs - 5 });
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ errorCode: 'action_replaced' });
    }
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('refuses an expired action with action_expired, clears it and does not run it', async () => {
    const lapsedTs = Date.now() - EXPIRY_MS - 1000;
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'create_issue', params: {}, ts: lapsedTs },
    } as never);

    const result = await decide({ pendingActionTs: lapsedTs });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ errorCode: 'action_expired' });
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, lapsedTs);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('rejects a replayed approval: the second answer loses the claim and runs nothing', async () => {
    vi.mocked(claimPendingAction).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await decide();
    const replay = await decide();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ errorCode: 'action_already_resolved' });
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);
  });

  it('reports action_already_resolved when the quest has no pending action left', async () => {
    vi.mocked(Quest.findById).mockResolvedValue({ sessionId: SESSION_ID, pendingAction: undefined } as never);

    const result = await decide({ confirmed: false });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ errorCode: 'action_already_resolved' });
  });

  it('rejects a deny that loses the claim to a concurrent answer', async () => {
    vi.mocked(claimPendingAction).mockResolvedValue(false);

    const result = await decide({ confirmed: false });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ errorCode: 'action_already_resolved' });
  });

  it('refuses an expired action on deny too, clearing it without running anything', async () => {
    const lapsedTs = Date.now() - EXPIRY_MS - 1000;
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'create_issue', params: {}, ts: lapsedTs },
    } as never);

    const result = await decide({ confirmed: false, pendingActionTs: lapsedTs });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ errorCode: 'action_expired' });
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, lapsedTs);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('answers 404 for a quest with no session, without looking a session up', async () => {
    vi.mocked(Quest.findById).mockResolvedValue({ pendingAction: undefined } as never);

    await expect(decide()).rejects.toBeInstanceOf(NotFoundError);
    expect(Session.findById).not.toHaveBeenCalled();
  });

  it('hides the error text of a tool that threw behind a generic 500', async () => {
    vi.mocked(invokeMcpHandler).mockRejectedValue(new Error('mongo://user:secret@host timed out'));

    const result = await decide();

    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });

  it('keeps the error envelope free of the success flag on client errors', async () => {
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['other/repo']);

    const result = await decide();

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).not.toHaveProperty('success');
  });
});
