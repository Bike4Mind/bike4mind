// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

// The route is baseApi().post(handler); unwrap it so the test drives the bare handler.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { post: (fn: unknown) => unknown };
  const chain: Chain = { post: fn => fn };
  return { baseApi: () => chain };
});

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  Session: { findById: vi.fn() },
  Quest: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
  fabFileRepository: { shareable: { findAccessibleById: vi.fn() } },
}));

vi.mock('@server/utils/storage', () => {
  const storage = { download: vi.fn().mockResolvedValue(Buffer.from('file-bytes')) };
  return { getFilesStorage: () => storage };
});

vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@server/utils/downloadAttachmentUrl', () => ({ downloadAttachmentUrl: vi.fn() }));
vi.mock('@server/utils/pendingActionExecutor', () => ({ claimPendingAction: vi.fn() }));
vi.mock('@server/integrations/github/github-repo-helper', () => ({ getSelectedRepositoriesForMcp: vi.fn() }));

vi.mock('@bike4mind/slack', () => {
  class StubResource {
    getMcpEnvVariables = vi.fn().mockResolvedValue([]);
  }
  return { GitHubResource: StubResource, JiraResource: StubResource, ConfluenceResource: StubResource };
});

import { fabFileRepository, Quest, Session } from '@bike4mind/database';
import { getFilesStorage } from '@server/utils/storage';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { downloadAttachmentUrl } from '@server/utils/downloadAttachmentUrl';
import { JIRA_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';
import { claimPendingAction } from '@server/utils/pendingActionExecutor';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { ForbiddenError } from '@server/utils/errors';
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
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({ _executeFromButton: true });
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].userId).toBe('user-1');
    expect(vi.mocked(claimPendingAction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeMcpHandler).mock.invocationCallOrder[0]
    );
  });

  it('downloads slackFileUrl through the SSRF-guarded helper and passes its bytes as base64 content', async () => {
    const fileBuffer = Buffer.from('x'.repeat(200));
    vi.mocked(downloadAttachmentUrl).mockResolvedValueOnce(fileBuffer);
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: {
        tool: JIRA_UPLOAD_ATTACHMENT,
        params: { issueKey: 'K-1', filename: 'a.txt', slackFileUrl: 'https://h.example.com/a' },
        ts: pendingActionTs,
      },
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(200);
    expect(downloadAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentUrl).toHaveBeenCalledWith('https://h.example.com/a');
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
      content: fileBuffer.toString('base64'),
    });
  });

  it('leaves the action unclaimed and answers generically when the attachment download fails', async () => {
    vi.mocked(downloadAttachmentUrl).mockRejectedValueOnce(
      new Error('URL blocked for security reasons: Hostname resolves to private IP address (127.0.0.1)')
    );
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: {
        tool: JIRA_UPLOAD_ATTACHMENT,
        params: { issueKey: 'K-1', filename: 'a.txt', slackFileUrl: 'http://internal.example/a' },
        ts: pendingActionTs,
      },
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData().error).not.toContain('127.0.0.1');
    // Left unclaimed so the user can fix the URL and retry.
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('refuses before claiming or invoking anything while the MCP admin flag is off', async () => {
    vi.mocked(assertMcpServerEnabled).mockRejectedValueOnce(new ForbiddenError('MCP servers are disabled'));

    await expect(
      post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('returns 409 and does not invoke the tool when the claim is lost', async () => {
    vi.mocked(claimPendingAction).mockResolvedValue(false);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(409);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('keeps the action unclaimed when a fixable pre-execution check fails', async () => {
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['other/repo']);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(400);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('matches the selected repository regardless of case but still refuses a different one', async () => {
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['acme/app']);

    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: {
        tool: 'create_issue',
        params: { owner: 'Acme', repo: 'App', title: 't' },
        ts: pendingActionTs,
      },
    } as never);
    const selected = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });
    expect(selected._getStatusCode()).toBe(200);
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);

    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: {
        tool: 'create_issue',
        params: { owner: 'Acme', repo: 'Other', title: 't' },
        ts: pendingActionTs,
      },
    } as never);
    vi.mocked(invokeMcpHandler).mockClear();

    const unselected = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });
    expect(unselected._getStatusCode()).toBe(400);
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

  it('rejects a request that does not name the displayed action ts', async () => {
    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true });

    expect(res._getStatusCode()).toBe(400);
    expect(claimPendingAction).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'get_issue', 'unknown_tool'])(
    'refuses to execute a pending action for the non-confirmable tool %s',
    async tool => {
      vi.mocked(Quest.findById).mockResolvedValue({
        sessionId: SESSION_ID,
        pendingAction: { tool, params: {}, ts: pendingActionTs },
      } as never);

      const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

      expect(res._getStatusCode()).toBe(400);
      expect(claimPendingAction).not.toHaveBeenCalled();
      expect(invokeMcpHandler).not.toHaveBeenCalled();
    }
  );

  it('routes an allowlisted Atlassian tool to the atlassian server', async () => {
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'jira_create_issue', params: {}, ts: pendingActionTs },
    } as never);

    await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0]).toMatchObject({
      name: 'atlassian',
      toolName: 'jira_create_issue',
    });
  });

  describe('attachment upload from a stored file', () => {
    const FAB_FILE_ID = 'cccccccccccccccccccccccc';

    beforeEach(() => {
      vi.mocked(Quest.findById).mockResolvedValue({
        sessionId: SESSION_ID,
        pendingAction: {
          tool: 'jira_upload_attachment',
          params: { issueKey: 'P-1', filename: 'a.txt', fabFileId: FAB_FILE_ID },
          ts: pendingActionTs,
        },
      } as never);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('looks the file up scoped to the confirming user', async () => {
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue({
        filePath: 'files/a.txt',
        mimeType: 'text/plain',
        moderationStatus: 'clean',
      } as never);

      const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

      expect(res._getStatusCode()).toBe(200);
      expect(fabFileRepository.shareable.findAccessibleById).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        FAB_FILE_ID
      );
      expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
        content: Buffer.from('file-bytes').toString('base64'),
        mimeType: 'text/plain',
      });
    });

    it('refuses a file the confirming user cannot access, even with a Slack URL fallback, without fetching, claiming or invoking', async () => {
      vi.mocked(Quest.findById).mockResolvedValue({
        sessionId: SESSION_ID,
        pendingAction: {
          tool: 'jira_upload_attachment',
          params: {
            issueKey: 'P-1',
            filename: 'a.txt',
            fabFileId: FAB_FILE_ID,
            slackFileUrl: 'https://files.example.test/a.txt',
          },
          ts: pendingActionTs,
        },
      } as never);
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue(null);
      vi.stubGlobal('fetch', vi.fn());

      const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

      expect(res._getStatusCode()).toBe(403);
      expect(getFilesStorage().download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(claimPendingAction).not.toHaveBeenCalled();
      expect(invokeMcpHandler).not.toHaveBeenCalled();
    });

    it('falls back to the Slack URL, never uploading held bytes, when the stored file is not serveable', async () => {
      vi.mocked(Quest.findById).mockResolvedValue({
        sessionId: SESSION_ID,
        pendingAction: {
          tool: 'jira_upload_attachment',
          params: {
            issueKey: 'P-1',
            filename: 'a.txt',
            fabFileId: FAB_FILE_ID,
            slackFileUrl: 'https://files.example.test/a.txt',
          },
          ts: pendingActionTs,
        },
      } as never);
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue({
        filePath: 'files/a.txt',
        mimeType: 'text/plain',
        moderationStatus: 'pending',
      } as never);
      const slackBytes = Buffer.from('slack-bytes');
      vi.mocked(downloadAttachmentUrl).mockResolvedValueOnce(slackBytes);

      const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

      expect(res._getStatusCode()).toBe(200);
      expect(getFilesStorage().download).not.toHaveBeenCalled();
      expect(downloadAttachmentUrl).toHaveBeenCalledWith('https://files.example.test/a.txt');
      expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
        content: slackBytes.toString('base64'),
      });
    });
  });

  it('returns 500 but still consumes the action when execution throws', async () => {
    vi.mocked(invokeMcpHandler).mockRejectedValue(new Error('boom'));

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(500);
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
  });

  it('claims the stored action on cancel without invoking the tool', async () => {
    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: false, pendingActionTs });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('returns 409 on cancel when the claim is lost', async () => {
    vi.mocked(claimPendingAction).mockResolvedValue(false);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: false, pendingActionTs });

    expect(res._getStatusCode()).toBe(409);
  });

  it('returns 409 without claiming when a stale card cancels', async () => {
    const res = await post({
      questId: QUEST_ID,
      sessionId: SESSION_ID,
      confirmed: false,
      pendingActionTs: pendingActionTs - 1000,
    });

    expect(res._getStatusCode()).toBe(409);
    expect(claimPendingAction).not.toHaveBeenCalled();
  });

  it('claims the stored ts, not a bare unset, when the stored action has expired', async () => {
    const expiredTs = Date.now() - 16 * 60 * 1000;
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'create_issue', params: { owner: 'o', repo: 'r', title: 't' }, ts: expiredTs },
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs: expiredTs });

    expect(res._getStatusCode()).toBe(400);
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, expiredTs);
    expect(Quest.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('rejects a stale expired action as replaced before claiming it', async () => {
    const expiredTs = Date.now() - 16 * 60 * 1000;
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'create_issue', params: {}, ts: expiredTs },
    } as never);

    const res = await post({
      questId: QUEST_ID,
      sessionId: SESSION_ID,
      confirmed: true,
      pendingActionTs: expiredTs - 1,
    });

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({
      error: expect.stringContaining('replaced by a newer one'),
      errorCode: 'action_replaced',
    });
    expect(claimPendingAction).not.toHaveBeenCalled();
  });
  it('reports a partial bulk create with created and failed counts', async () => {
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'jira_bulk_create_issues', params: {}, ts: pendingActionTs },
    } as never);
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"success":true,"created":1,"failed":2,"issues":[{"key":"P-1"}],"errors":[{},{}]}',
        },
      ],
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(res._getJSONData().message).toContain('Created 1 of 3');
    expect(res._getJSONData().message).toContain('2 failed');
  });

  it('reports a bulk create where every issue failed as a failure with the count', async () => {
    vi.mocked(Quest.findById).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingAction: { tool: 'jira_bulk_create_issues', params: {}, ts: pendingActionTs },
    } as never);
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [{ type: 'text', text: '{"success":false,"created":0,"failed":2,"issues":[],"errors":[{},{}]}' }],
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getJSONData()).toMatchObject({
      success: false,
      message: 'No Jira issues were created; 2 failed',
    });
  });

  it('reports failure when the MCP result carries isError', async () => {
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [{ type: 'text', text: 'Error: boom' }],
      isError: true,
    } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: false });
  });

  it('reports failure when the result text starts with "Error:" and isError is absent', async () => {
    vi.mocked(invokeMcpHandler).mockResolvedValue({ content: [{ type: 'text', text: 'Error: boom' }] } as never);

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: true, pendingActionTs });

    expect(res._getJSONData()).toMatchObject({ success: false, message: 'Error: boom' });
  });

  it('still cancels when the MCP admin flag is off', async () => {
    vi.mocked(assertMcpServerEnabled).mockRejectedValue(new ForbiddenError('MCP servers are disabled'));

    const res = await post({ questId: QUEST_ID, sessionId: SESSION_ID, confirmed: false, pendingActionTs });

    expect(res._getStatusCode()).toBe(200);
    expect(claimPendingAction).toHaveBeenCalledWith(QUEST_ID, pendingActionTs);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });
});
