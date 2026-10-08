// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

// The route is baseApi().post(handler); unwrap it so the test drives the bare handler.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { post: (fn: unknown) => unknown };
  const chain: Chain = { post: fn => fn };
  return { baseApi: () => chain };
});

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  Session: { findById: vi.fn() },
  Quest: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
  FabFile: { findById: vi.fn() },
}));

vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@server/utils/pendingActionExecutor', () => ({ claimPendingAction: vi.fn() }));
vi.mock('@server/integrations/github/github-repo-helper', () => ({ getSelectedRepositoriesForMcp: vi.fn() }));

vi.mock('@bike4mind/slack', () => {
  class StubResource {
    getMcpEnvVariables = vi.fn().mockResolvedValue([]);
  }
  return { GitHubResource: StubResource, JiraResource: StubResource, ConfluenceResource: StubResource };
});

import { Quest, Session } from '@bike4mind/database';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { claimPendingAction } from '@server/utils/pendingActionExecutor';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
import handler from '../confirm';

const SESSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const QUEST_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const routeHandler = handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'user-1' } });
  await routeHandler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

describe('POST /api/mcp/confirm', () => {
  let pendingActionTs: number;

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
      content: [{ text: JSON.stringify({ url: 'https://example.test/x' }) }],
    } as never);
  });

  it('claims the stored action before invoking the tool, and only for the displayed action', async () => {
    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(200);
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({ _executeFromButton: true });
    expect(vi.mocked(claimPendingAction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeMcpHandler).mock.invocationCallOrder[0]
    );
  });

  it('returns 409 and does not invoke the tool when the claim is lost', async () => {
    vi.mocked(claimPendingAction).mockResolvedValue(false);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true });

    expect(res._getStatusCode()).toBe(409);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('keeps the action unclaimed when a fixable pre-execution check fails', async () => {
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['other/repo']);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true });

    expect(res._getStatusCode()).toBe(400);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('returns 409 without claiming when the displayed action was replaced', async () => {
    const res = await post({
      questId: QUEST_ID,
      sessionId: SESSION_ID,
      confirmed: true,
      pendingActionTs: pendingActionTs - 1000,
    });

    expect(res._getStatusCode()).toBe(409);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('does not claim or invoke anything on cancel', async () => {
    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: false });

    expect(res._getStatusCode()).toBe(200);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });
});
