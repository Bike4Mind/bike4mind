// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { JIRA_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

vi.mock('@bike4mind/database', () => ({
  Quest: { findById: vi.fn(), findOneAndUpdate: vi.fn(), findByIdAndUpdate: vi.fn() },
  FabFile: { findById: vi.fn() },
  Session: { findById: vi.fn() },
}));

vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@server/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@server/integrations/github/github-repo-helper', () => ({ getSelectedRepositoriesForMcp: vi.fn() }));

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

import { Quest, Session } from '@bike4mind/database';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { isFeatureEnabled } from '@server/middlewares/featureFlag';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }));

    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to download file');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('rejects a button whose action was replaced, without claiming or invoking', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, ts - 1);

    expect(result.success).toBe(false);
    expect(result.message).toContain('replaced by a newer one');
    expect(Quest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('still executes for a legacy button that carries no expected ts', async () => {
    const result = await executePendingAction(QUEST_ID, dbUser, logger, undefined);

    expect(result.success).toBe(true);
    expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: QUEST_ID, 'pendingAction.ts': ts },
      { $unset: { pendingAction: 1 } }
    );
    expect(vi.mocked(invokeMcpHandler).mock.calls[0][0].toolArgs).toMatchObject({ _executeFromButton: true });
    expect(vi.mocked(Quest.findOneAndUpdate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invokeMcpHandler).mock.invocationCallOrder[0]
    );
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
