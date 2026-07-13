import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist mock functions to avoid initialization issues
const { mockNotify, mockFindByOrgAndRepo, mockUserFind, mockDispatchIssueToSre, mockSyncSreIssueState } = vi.hoisted(
  () => ({
    mockNotify: vi.fn(),
    mockFindByOrgAndRepo: vi.fn(),
    mockUserFind: vi.fn(),
    mockDispatchIssueToSre: vi.fn(),
    mockSyncSreIssueState: vi.fn(),
  })
);

vi.mock('@bike4mind/slack', () => ({
  GitHubSlackNotifier: vi.fn().mockImplementation(function () {
    return { notify: mockNotify };
  }),
  buildIssueOpenedBlocks: vi.fn().mockReturnValue({ text: 'issue opened', blocks: [] }),
  buildIssueClosedBlocks: vi.fn().mockReturnValue({ text: 'issue closed', blocks: [] }),
  buildIssueAssignedBlocks: vi.fn().mockReturnValue({ text: 'issue assigned', blocks: [] }),
}));

vi.mock('@bike4mind/database', () => ({
  webhookSubscriptionRepository: {
    findByOrgAndRepo: mockFindByOrgAndRepo,
  },
  User: {
    find: mockUserFind,
  },
}));

vi.mock('@server/integrations/github/sreWebhookDispatch', () => ({
  dispatchIssueToSre: mockDispatchIssueToSre,
  syncSreIssueStateFromWebhook: mockSyncSreIssueState,
}));

import { IssuesHandler } from '@server/integrations/github/handlers/IssuesHandler';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import type { GitHubIssuesPayload } from '@server/integrations/github/types';
import type { IMcpServerDocument } from '@bike4mind/common';

function createIssuesPayload(
  overrides: Partial<{
    action: string;
    issueNumber: number;
    issueTitle: string;
    author: string;
    assignees: Array<{ login: string; id: number }>;
    body: string;
  }>
): GitHubIssuesPayload {
  return {
    action: overrides.action ?? 'opened',
    repository: { full_name: 'owner/repo' },
    sender: { login: overrides.author ?? 'issue-author' },
    issue: {
      number: overrides.issueNumber ?? 42,
      title: overrides.issueTitle ?? 'Test issue',
      html_url: 'https://github.com/owner/repo/issues/42',
      state: 'open',
      user: { login: overrides.author ?? 'issue-author', id: 1, html_url: 'https://github.com/issue-author' },
      assignees: overrides.assignees ?? [],
      body: overrides.body ?? 'Issue body content',
    },
  } as GitHubIssuesPayload;
}

const mockMcpServer = { id: 'mcp-1' } as IMcpServerDocument;

describe('IssuesHandler', () => {
  let handler: IssuesHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    mockFindByOrgAndRepo.mockResolvedValue([]);
    mockUserFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDispatchIssueToSre.mockResolvedValue({ dispatched: false, reason: 'pipeline-disabled' });
    mockSyncSreIssueState.mockResolvedValue(undefined);
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new IssuesHandler(notifier);
  });

  describe('action filtering', () => {
    it('should process "opened" action', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        assignees: [{ login: 'assignee-user', id: 2 }],
      });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).toHaveBeenCalledWith(
        'issueOpened',
        expect.any(Array),
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should process "closed" action', async () => {
      const payload = createIssuesPayload({ action: 'closed' });
      // Set sender to be different from author to trigger notification
      (payload as GitHubIssuesPayload).sender = { login: 'closer-user' } as GitHubIssuesPayload['sender'];
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).toHaveBeenCalledWith(
        'issueClosed',
        expect.any(Array),
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should skip "labeled" action', async () => {
      const payload = createIssuesPayload({ action: 'labeled' });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should skip "unlabeled" action', async () => {
      const payload = createIssuesPayload({ action: 'unlabeled' });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should route "reopened" action to SRE dispatch', async () => {
      const payload = createIssuesPayload({ action: 'reopened' });
      await handler.handle(payload, mockMcpServer);
      // No Slack notification for reopens (out of scope), but SRE must see it
      // so the fix-loop guard can catch "fix didn't work" signals.
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockDispatchIssueToSre).toHaveBeenCalledTimes(1);
      const [forwardedPayload] = mockDispatchIssueToSre.mock.calls[0];
      expect(forwardedPayload).toBe(payload);
    });

    it('should route "labeled" action to SRE dispatch', async () => {
      // Regression guard - covers the same SRE-routing path as reopened.
      const payload = createIssuesPayload({ action: 'labeled' });
      await handler.handle(payload, mockMcpServer);
      expect(mockDispatchIssueToSre).toHaveBeenCalledTimes(1);
    });

    it('should route "opened" action to SRE dispatch', async () => {
      // Regression guard - opened was the original SRE entry point.
      const payload = createIssuesPayload({ action: 'opened' });
      await handler.handle(payload, mockMcpServer);
      expect(mockDispatchIssueToSre).toHaveBeenCalledTimes(1);
    });

    it('should NOT route "closed" action to SRE dispatch', async () => {
      // Closing the issue must not re-enter the pipeline.
      const payload = createIssuesPayload({ action: 'closed' });
      (payload as GitHubIssuesPayload).sender = { login: 'closer-user' } as GitHubIssuesPayload['sender'];
      await handler.handle(payload, mockMcpServer);
      expect(mockDispatchIssueToSre).not.toHaveBeenCalled();
    });

    it.each(['opened', 'labeled', 'reopened'])(
      'isolates SRE dispatch failures from the outer handler ("%s" action)',
      async action => {
        // Each handler wraps `dispatchToSreIfMatching` in try/catch so an SRE
        // dispatch failure doesn't break existing notification flows. Verify
        // by rejecting the mock and asserting handler.handle() still resolves.
        mockDispatchIssueToSre.mockRejectedValueOnce(new Error('SQS unavailable'));
        const payload = createIssuesPayload({ action });
        await expect(handler.handle(payload, mockMcpServer)).resolves.toBeDefined();
        expect(mockDispatchIssueToSre).toHaveBeenCalled();
      }
    );
  });

  describe('githubIssueState sync (admin "hide closed issues" filter)', () => {
    it('syncs issue state on "closed" so the tracking doc reflects the close', async () => {
      const payload = createIssuesPayload({ action: 'closed' });
      (payload as GitHubIssuesPayload).sender = { login: 'closer-user' } as GitHubIssuesPayload['sender'];
      await handler.handle(payload, mockMcpServer);
      expect(mockSyncSreIssueState).toHaveBeenCalledTimes(1);
      expect(mockSyncSreIssueState.mock.calls[0][0]).toBe(payload);
    });

    it('syncs issue state on "closed" even when the author closed their own issue (no Slack notification path)', async () => {
      // Author == closer short-circuits the Slack notification, but the state
      // sync must still run - it's placed before that early return.
      const payload = createIssuesPayload({ action: 'closed', author: 'self-closer' });
      (payload as GitHubIssuesPayload).sender = { login: 'self-closer' } as GitHubIssuesPayload['sender'];
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockSyncSreIssueState).toHaveBeenCalledTimes(1);
    });

    it('syncs issue state on "reopened"', async () => {
      const payload = createIssuesPayload({ action: 'reopened' });
      await handler.handle(payload, mockMcpServer);
      expect(mockSyncSreIssueState).toHaveBeenCalledTimes(1);
      expect(mockSyncSreIssueState.mock.calls[0][0]).toBe(payload);
    });

    it('does not sync issue state on "opened" (state is already open at creation)', async () => {
      const payload = createIssuesPayload({ action: 'opened' });
      await handler.handle(payload, mockMcpServer);
      expect(mockSyncSreIssueState).not.toHaveBeenCalled();
    });
  });

  describe('handleOpened - assignee notifications', () => {
    it('should notify assignees on issue opened', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [
          { login: 'assignee1', id: 2 },
          { login: 'assignee2', id: 3 },
        ],
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith(
        'issueOpened',
        ['assignee1', 'assignee2'],
        expect.any(Function),
        expect.objectContaining({})
      );
    });

    it('should NOT notify the author if they are an assignee', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [
          { login: 'author-user', id: 1 }, // Author assigned themselves
          { login: 'other-user', id: 2 },
        ],
      });
      await handler.handle(payload, mockMcpServer);

      const targetUsernames = mockNotify.mock.calls[0][1] as string[];
      expect(targetUsernames).not.toContain('author-user');
      expect(targetUsernames).toContain('other-user');
    });

    it('should handle case-insensitive author exclusion', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        author: 'Author-User',
        assignees: [
          { login: 'AUTHOR-USER', id: 1 }, // Same user, different case
          { login: 'other-user', id: 2 },
        ],
      });
      await handler.handle(payload, mockMcpServer);

      const targetUsernames = mockNotify.mock.calls[0][1] as string[];
      expect(targetUsernames).not.toContain('AUTHOR-USER');
      expect(targetUsernames).toContain('other-user');
    });

    it('should not call notify when no assignees exist', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        assignees: [],
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should not call notify when only assignee is the author', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [{ login: 'author-user', id: 1 }],
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });
  });

  describe('handleOpened - subscriber notifications', () => {
    it('should notify subscribers when orgId is present', async () => {
      // Setup: subscribers exist with GitHub usernames configured
      mockFindByOrgAndRepo.mockResolvedValue([
        { userId: 'user-1', events: [], enabled: true },
        { userId: 'user-2', events: ['issues'], enabled: true },
      ]);

      mockUserFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi
            .fn()
            .mockResolvedValue([
              { slackSettings: { githubNotifications: { githubUsername: 'subscriber1' } } },
              { slackSettings: { githubNotifications: { githubUsername: 'subscriber2' } } },
            ]),
        }),
      });

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [], // No assignees, so only subscribers get notified
      });

      await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      expect(mockFindByOrgAndRepo).toHaveBeenCalledWith('org-123', 'owner/repo');
      expect(mockNotify).toHaveBeenCalledWith('issueOpened', ['subscriber1', 'subscriber2'], expect.any(Function), {
        orgId: 'org-123',
      });
    });

    it('should NOT notify subscribers who are the issue author', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([{ userId: 'user-1', events: [], enabled: true }]);

      mockUserFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { slackSettings: { githubNotifications: { githubUsername: 'author-user' } } }, // Author is a subscriber
          ]),
        }),
      });

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [],
      });

      await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      // Notify should not be called because the only subscriber is the author
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should filter subscribers to those who want issues events', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([
        { userId: 'user-1', events: ['push'], enabled: true }, // Only wants push events
        { userId: 'user-2', events: ['issues'], enabled: true }, // Wants issues events
        { userId: 'user-3', events: [], enabled: true }, // Empty = all events
      ]);

      mockUserFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi
            .fn()
            .mockResolvedValue([
              { slackSettings: { githubNotifications: { githubUsername: 'subscriber2' } } },
              { slackSettings: { githubNotifications: { githubUsername: 'subscriber3' } } },
            ]),
        }),
      });

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [],
      });

      await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      // User.find should only be called with user-2 and user-3, not user-1
      expect(mockUserFind).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: { $in: ['user-2', 'user-3'] },
        })
      );
    });

    it('should deduplicate assignees and subscribers', async () => {
      // subscriber1 is also an assignee - should only get ONE notification
      mockFindByOrgAndRepo.mockResolvedValue([{ userId: 'user-1', events: [], enabled: true }]);

      mockUserFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { slackSettings: { githubNotifications: { githubUsername: 'assignee1' } } }, // Also an assignee
          ]),
        }),
      });

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [{ login: 'assignee1', id: 2 }],
      });

      await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      // First call is for assignees
      expect(mockNotify).toHaveBeenCalledWith('issueOpened', ['assignee1'], expect.any(Function), expect.any(Object));

      // Subscriber notification should NOT include assignee1 (already notified)
      // Since the only subscriber is the assignee, second notify call should not happen
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleOpened - context passing', () => {
    it('should pass orgId in options to notifier', async () => {
      const payload = createIssuesPayload({
        action: 'opened',
        assignees: [{ login: 'assignee1', id: 2 }],
      });

      await handler.handle(payload, mockMcpServer, { orgId: 'org-456' });

      expect(mockNotify).toHaveBeenCalledWith('issueOpened', expect.any(Array), expect.any(Function), {
        orgId: 'org-456',
      });
    });
  });

  describe('error handling', () => {
    it('should surface notificationDispatchError when subscriber lookup fails (keeps assignee notifications)', async () => {
      mockFindByOrgAndRepo.mockRejectedValue(new Error('Database error'));

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [{ login: 'assignee1', id: 2 }],
      });

      // Should not throw - should return assignee notifications that succeeded
      const result = await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      // Assignee notification still happens
      expect(mockNotify).toHaveBeenCalledWith('issueOpened', ['assignee1'], expect.any(Function), expect.any(Object));
      // The subscriber-lookup failure must surface so the queue handler records Failed, not Skipped.
      expect(result.notificationDispatchError).toBe('Subscriber lookup failed: Database error');
      expect(result.notifiedUserIds).toEqual([]);
    });

    it('should surface notificationDispatchError when User.find fails', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([{ userId: 'user-1', events: [], enabled: true }]);
      mockUserFind.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Replica failover')),
        }),
      });

      const payload = createIssuesPayload({
        action: 'opened',
        author: 'author-user',
        assignees: [], // No assignees so the only path is subscriber lookup
      });

      const result = await handler.handle(payload, mockMcpServer, { orgId: 'org-123' });

      expect(result.notificationDispatchError).toBe('Subscriber lookup failed: Replica failover');
      expect(result.notifiedUserIds).toEqual([]);
    });
  });
});
