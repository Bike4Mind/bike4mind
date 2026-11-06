// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { JIRA_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

vi.mock('@bike4mind/database', () => ({
  Quest: { findById: vi.fn(), findOneAndUpdate: vi.fn(), findByIdAndUpdate: vi.fn() },
  Session: { findById: vi.fn() },
  fabFileRepository: { findByIdAndUserId: vi.fn(), shareable: { findAccessibleById: vi.fn() } },
}));

vi.mock('@bike4mind/database/infra', () => ({
  SlackDevWorkspace: { findById: vi.fn() },
  OrgSlackWorkspace: { findById: vi.fn() },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => {
  const storage = { getSignedUrl: vi.fn(), download: vi.fn().mockResolvedValue(Buffer.from('file-bytes')) };
  return { getFilesStorage: () => storage };
});

vi.mock('@bike4mind/server-utils/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/downloadAttachmentUrl', () => ({ downloadAttachmentUrl: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/github/github-repo-helper', () => ({
  getSelectedRepositoriesForMcp: vi.fn(),
}));

vi.mock('@bike4mind/slack', () => {
  class StubResource {
    getMcpEnvVariables = vi.fn().mockResolvedValue([]);
  }
  return {
    GitHubResource: StubResource,
    JiraResource: StubResource,
    ConfluenceResource: StubResource,
    TOKEN_EXPIRATION_MS: 60_000,
  };
});

import { fabFileRepository, Quest, Session } from '@bike4mind/database';
import { SlackDevWorkspace, OrgSlackWorkspace } from '@bike4mind/database/infra';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { invokeMcpHandler } from '@bike4mind/server-utils/utils/invokeMcpHandler';
import { downloadAttachmentUrl } from '@bike4mind/server-utils/utils/downloadAttachmentUrl';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { getSelectedRepositoriesForMcp } from '@bike4mind/server-utils/integrations/github/github-repo-helper';
import {
  cancelPendingActionOnQuest,
  executePendingAction,
  isPendingActionRequester,
  TOKEN_EXPIRATION_MS,
} from './pendingActionExecutor';

const QUEST_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const dbUser = { id: 'user-1' } as unknown as IUserDocument;

type PendingActionFixture = { tool: string; params: Record<string, unknown>; ts: number };

function storePendingAction(pendingAction: PendingActionFixture) {
  vi.mocked(Quest.findById).mockResolvedValue({ pendingAction } as never);
}

describe('executePendingAction', () => {
  let ts: number;

  beforeEach(() => {
    vi.clearAllMocks();
    ts = Date.now();
    storePendingAction({ tool: 'create_issue', params: { owner: 'o', repo: 'r', title: 't' }, ts });
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue({} as never);
    vi.mocked(getSelectedRepositoriesForMcp).mockResolvedValue(['o/r']);
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [{ text: JSON.stringify({ url: 'https://example.test/x', number: 7 }) }],
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to run any pending action while the MCP admin flag is off', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);

    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(result.success).toBe(false);
    expect(isFeatureEnabled).toHaveBeenCalledWith('EnableMCPServer');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('claims the stored action before invoking the tool and marks the call as button-initiated', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(result.success).toBe(true);
    expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: QUEST_ID, 'pendingAction.ts': ts },
      { $unset: { pendingAction: 1 } }
    );
    expect(invokeMcpHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({ _executeFromButton: true });
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].userId).toBe(dbUser.id);
    expect(vi.mocked(Quest.findOneAndUpdate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeMcpHandler).mock.invocationCallOrder[0]
    );
  });

  it('does not invoke the tool when the claim is lost to another click', async () => {
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue(null as never);

    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(result.success).toBe(false);
    expect(result.message).toContain('already been processed');
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('leaves the action unclaimed when the file download fails', async () => {
    storePendingAction({
      tool: JIRA_UPLOAD_ATTACHMENT,
      params: { issueKey: 'K-1', filename: 'a.txt', slackFileUrl: 'https://files.example.test/a.txt' },
      ts,
    });
    vi.mocked(downloadAttachmentUrl).mockRejectedValueOnce(new Error('URL blocked for security reasons: private'));

    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(downloadAttachmentUrl).toHaveBeenCalledWith('https://files.example.test/a.txt');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to download file');
    expect(result.message).not.toContain('blocked');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('downloads the slack file through the SSRF-guarded helper and passes its bytes as base64 content', async () => {
    const fileBuffer = Buffer.from('x'.repeat(200));
    vi.mocked(downloadAttachmentUrl).mockResolvedValueOnce(fileBuffer);
    storePendingAction({
      tool: JIRA_UPLOAD_ATTACHMENT,
      params: { issueKey: 'K-1', filename: 'a.txt', slackFileUrl: 'https://h.example.com/a' },
      ts,
    });

    await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(downloadAttachmentUrl).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentUrl).toHaveBeenCalledWith('https://h.example.com/a');
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
      content: fileBuffer.toString('base64'),
    });
  });

  it('rejects a button whose action was replaced, without claiming or invoking', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts - 1);

    expect(result.success).toBe(false);
    expect(result.message).toContain('replaced by a newer one');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'get_issue', 'unknown_tool'])(
    'refuses a pending action for the non-confirmable tool %s',
    async tool => {
      storePendingAction({ tool, params: {}, ts });

      const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

      expect(result.success).toBe(false);
      expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
      expect(invokeMcpHandler).not.toHaveBeenCalled();
    }
  );

  describe('attachment upload from a stored file', () => {
    const FAB_FILE_ID = 'cccccccccccccccccccccccc';

    beforeEach(() => {
      storePendingAction({
        tool: JIRA_UPLOAD_ATTACHMENT,
        params: { issueKey: 'K-1', filename: 'a.txt', fabFileId: FAB_FILE_ID },
        ts,
      });
    });

    it('looks the file up scoped to the confirming user and uploads its bytes', async () => {
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue({
        filePath: 'files/a.txt',
        mimeType: 'text/plain',
        moderationStatus: 'clean',
      } as never);

      const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

      expect(result.success).toBe(true);
      expect(fabFileRepository.shareable.findAccessibleById).toHaveBeenCalledWith(dbUser, FAB_FILE_ID);
      expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
        content: Buffer.from('file-bytes').toString('base64'),
        mimeType: 'text/plain',
      });
    });

    it('falls back to the Slack URL, never uploading held bytes, when the stored file is not serveable', async () => {
      storePendingAction({
        tool: JIRA_UPLOAD_ATTACHMENT,
        params: {
          issueKey: 'K-1',
          filename: 'a.txt',
          fabFileId: FAB_FILE_ID,
          slackFileUrl: 'https://files.example.test/a.txt',
        },
        ts,
      });
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue({
        filePath: 'files/a.txt',
        mimeType: 'text/plain',
        moderationStatus: 'pending',
      } as never);
      const slackBytes = Buffer.from('slack-bytes');
      vi.mocked(downloadAttachmentUrl).mockResolvedValueOnce(slackBytes);

      const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

      expect(result.success).toBe(true);
      expect(getFilesStorage().download).not.toHaveBeenCalled();
      expect(downloadAttachmentUrl).toHaveBeenCalledWith('https://files.example.test/a.txt');
      expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({
        content: slackBytes.toString('base64'),
      });
    });

    it('refuses a file the confirming user cannot access, even with a Slack URL fallback, without fetching, claiming or invoking', async () => {
      storePendingAction({
        tool: JIRA_UPLOAD_ATTACHMENT,
        params: {
          issueKey: 'K-1',
          filename: 'a.txt',
          fabFileId: FAB_FILE_ID,
          slackFileUrl: 'https://files.example.test/a.txt',
        },
        ts,
      });
      vi.mocked(fabFileRepository.shareable.findAccessibleById).mockResolvedValue(null);
      vi.stubGlobal('fetch', vi.fn());

      const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

      expect(result.success).toBe(false);
      expect(getFilesStorage().download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
      expect(invokeMcpHandler).not.toHaveBeenCalled();
    });
  });

  it('claims an expired action by its stored ts and does not invoke the tool', async () => {
    const expiredTs = Date.now() - TOKEN_EXPIRATION_MS - 1000;
    storePendingAction({ tool: 'create_issue', params: {}, ts: expiredTs });

    const result = await executePendingAction(QUEST_ID, dbUser, logger, expiredTs);

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: QUEST_ID, 'pendingAction.ts': expiredTs },
      { $unset: { pendingAction: 1 } }
    );
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('rejects a stale expired action as replaced before claiming it', async () => {
    const expiredTs = Date.now() - TOKEN_EXPIRATION_MS - 1000;
    storePendingAction({ tool: 'create_issue', params: {}, ts: expiredTs });

    const result = await executePendingAction(QUEST_ID, dbUser, logger, expiredTs - 1);

    expect(result.success).toBe(false);
    expect(result.message).toContain('replaced by a newer one');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });
});

describe('cancelPendingActionOnQuest', () => {
  const ts = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears only the displayed action when the claim wins', async () => {
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue({} as never);

    const result = await cancelPendingActionOnQuest(QUEST_ID, logger, ts);

    expect(result.success).toBe(true);
    expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: QUEST_ID, 'pendingAction.ts': ts },
      { $unset: { pendingAction: 1 } }
    );
    expect(Quest.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('reports failure when the displayed action was already processed or replaced', async () => {
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue(null as never);

    const result = await cancelPendingActionOnQuest(QUEST_ID, logger, ts);

    expect(result.success).toBe(false);
    expect(Quest.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('clears whatever is pending when no expected ts is given', async () => {
    vi.mocked(Quest.findByIdAndUpdate).mockResolvedValue({} as never);

    const result = await cancelPendingActionOnQuest(QUEST_ID, logger);

    expect(result.success).toBe(true);
    expect(Quest.findByIdAndUpdate).toHaveBeenCalledWith(QUEST_ID, { $unset: { pendingAction: 1 } });
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('isPendingActionRequester', () => {
  const SESSION_ID = 'cccccccccccccccccccccccc';

  function storeQuest(quest: { sessionId: string; requesterId?: string } | null, sessionOwnerId: string | null) {
    const questDoc = quest && {
      sessionId: quest.sessionId,
      ...(quest.requesterId ? { promptMeta: { session: { userId: quest.requesterId } } } : {}),
    };
    vi.mocked(Quest.findById).mockReturnValue({ select: () => Promise.resolve(questDoc) } as never);
    vi.mocked(Session.findById).mockReturnValue({
      select: () => Promise.resolve(sessionOwnerId === null ? null : { userId: sessionOwnerId }),
    } as never);
  }

  beforeEach(() => vi.clearAllMocks());

  it('is true for the turn requester even when someone else owns the session', async () => {
    storeQuest({ sessionId: SESSION_ID, requesterId: 'user-1' }, 'owner-2');

    await expect(isPendingActionRequester(QUEST_ID, 'user-1')).resolves.toBe(true);
    expect(Session.findById).not.toHaveBeenCalled();
  });

  it('is false for the session owner when another user made the request', async () => {
    storeQuest({ sessionId: SESSION_ID, requesterId: 'user-1' }, 'owner-2');

    await expect(isPendingActionRequester(QUEST_ID, 'owner-2')).resolves.toBe(false);
  });

  it('falls back to the session owner for a quest with no recorded requester', async () => {
    storeQuest({ sessionId: SESSION_ID }, 'user-1');

    await expect(isPendingActionRequester(QUEST_ID, 'user-1')).resolves.toBe(true);
    await expect(isPendingActionRequester(QUEST_ID, 'user-2')).resolves.toBe(false);
    expect(Session.findById).toHaveBeenCalledWith(SESSION_ID);
  });

  it.each([
    ['the quest is missing', null, 'user-1'],
    ['the session is missing', { sessionId: SESSION_ID }, null],
  ])('is false when %s', async (_label, quest, sessionOwnerId) => {
    storeQuest(quest, sessionOwnerId);

    await expect(isPendingActionRequester(QUEST_ID, 'user-1')).resolves.toBe(false);
  });

  it('is false for a malformed quest id without querying', async () => {
    await expect(isPendingActionRequester('not-an-id', 'user-1')).resolves.toBe(false);
    expect(Quest.findById).not.toHaveBeenCalled();
  });
});

describe('confirmed curated-file sharing', () => {
  const storedWorkspaceId = 'dddddddddddddddddddddddd';
  const destination = { slackTeamId: 'T123', channelId: 'C123' };
  const fileId = 'cccccccccccccccccccccccc';
  const selectResolving = (value: unknown) => ({ select: () => Promise.resolve(value) });
  let ts: number;
  beforeEach(() => {
    vi.clearAllMocks();
    ts = Date.now();
    vi.mocked(Quest.findById).mockReturnValue({
      pendingAction: {
        tool: 'share_curated_file',
        ts,
        params: { fileId, userId: dbUser.id, workspaceId: storedWorkspaceId, channelId: destination.channelId },
      },
      select: () => Promise.resolve({ promptMeta: { session: { userId: dbUser.id } } }),
    } as never);
    vi.mocked(SlackDevWorkspace.findById).mockReturnValue(
      selectResolving({ slackTeamId: destination.slackTeamId }) as never
    );
    vi.mocked(OrgSlackWorkspace.findById).mockReturnValue(selectResolving(null) as never);
    vi.mocked(fabFileRepository.findByIdAndUserId).mockResolvedValue({
      id: fileId,
      filePath: 'private/report.pdf',
      moderationStatus: 'clean',
      tags: [{ name: 'curated-notebook' }],
      mimeType: 'application/pdf',
    } as never);
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue({} as never);
    vi.mocked(getFilesStorage().getSignedUrl).mockResolvedValue('https://example.test/download');
  });

  it('rechecks file ownership and claims the action before minting a link', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts, destination);
    expect(result.success).toBe(true);
    expect(fabFileRepository.findByIdAndUserId).toHaveBeenCalledWith(fileId, dbUser.id);
    expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: QUEST_ID, 'pendingAction.ts': ts },
      { $unset: { pendingAction: 1 } }
    );
    expect(getFilesStorage().getSignedUrl).toHaveBeenCalledWith('private/report.pdf', 'get', { expiresIn: 604800 });
    expect(vi.mocked(Quest.findOneAndUpdate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getFilesStorage().getSignedUrl).mock.invocationCallOrder[0]
    );
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('refuses confirmation from another destination', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts, { ...destination, channelId: 'COTHER' });
    expect(result.success).toBe(false);
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a confirmation clicked in another Slack team', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts, {
      ...destination,
      slackTeamId: 'TOTHER',
    });
    expect(result.success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that names no destination', async () => {
    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts)).success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a confirmation from someone other than the turn requester', async () => {
    vi.mocked(Quest.findById).mockReturnValue({
      pendingAction: {
        tool: 'share_curated_file',
        ts,
        params: { fileId, userId: dbUser.id, workspaceId: storedWorkspaceId, channelId: destination.channelId },
      },
      select: () => Promise.resolve({ promptMeta: { session: { userId: 'user-2' } } }),
    } as never);

    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it('accepts an org-install destination resolved from the org workspace', async () => {
    vi.mocked(SlackDevWorkspace.findById).mockReturnValue(selectResolving(null) as never);
    vi.mocked(OrgSlackWorkspace.findById).mockReturnValue(
      selectResolving({ slackTeamId: destination.slackTeamId }) as never
    );

    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(true);
    expect(getFilesStorage().getSignedUrl).toHaveBeenCalled();
  });

  it('refuses an action whose file id is not an object id', async () => {
    vi.mocked(Quest.findById).mockReturnValue({
      pendingAction: {
        tool: 'share_curated_file',
        ts,
        params: {
          fileId: 'not-an-id',
          userId: dbUser.id,
          workspaceId: storedWorkspaceId,
          channelId: destination.channelId,
        },
      },
      select: () => Promise.resolve({ promptMeta: { session: { userId: dbUser.id } } }),
    } as never);

    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
    expect(fabFileRepository.findByIdAndUserId).not.toHaveBeenCalled();
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('consumes the action and reports failure when signing the link fails', async () => {
    vi.mocked(getFilesStorage().getSignedUrl).mockRejectedValue(new Error('storage down'));

    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
    expect(Quest.findOneAndUpdate).toHaveBeenCalled();
  });

  it('refuses a stale confirmation', async () => {
    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts - 1, destination)).success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a duplicate click that lost the atomic claim', async () => {
    vi.mocked(Quest.findOneAndUpdate).mockResolvedValue(null);
    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });

  it.each([{ deletedAt: new Date() }, { moderationStatus: 'blocked' }, { moderationStatus: 'pending' }, { tags: [] }])(
    'refuses a file that became unavailable after preview: %j',
    async changedState => {
      vi.mocked(fabFileRepository.findByIdAndUserId).mockResolvedValue({
        id: fileId,
        filePath: 'private/report.pdf',
        tags: [{ name: 'curated-notebook' }],
        moderationStatus: 'clean',
        mimeType: 'application/pdf',
        ...changedState,
      } as never);
      expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
      expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
      expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
    }
  );

  it('refuses a file that is no longer owned by the requester', async () => {
    vi.mocked(fabFileRepository.findByIdAndUserId).mockResolvedValue(null);
    expect((await executePendingAction(QUEST_ID, dbUser, logger, ts, destination)).success).toBe(false);
    expect(getFilesStorage().getSignedUrl).not.toHaveBeenCalled();
  });
});
