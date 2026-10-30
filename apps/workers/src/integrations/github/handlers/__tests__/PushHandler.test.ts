import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockNotify, mockFindByOrgAndRepo, mockAccounts } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockFindByOrgAndRepo: vi.fn(),
  mockAccounts: vi.fn(),
}));

vi.mock('@bike4mind/slack', () => ({
  findVerifiedGitHubAccounts: mockAccounts,
  GitHubSlackNotifier: vi.fn().mockImplementation(function () {
    return { notify: mockNotify };
  }),
  buildPushBlocks: vi.fn().mockReturnValue({ text: 'push', blocks: [] }),
}));

vi.mock('@bike4mind/database', () => ({
  webhookSubscriptionRepository: {
    findByOrgAndRepo: mockFindByOrgAndRepo,
  },
  User: {
    find: mockAccounts,
  },
}));

import { PushHandler } from '@workers/integrations/github/handlers/PushHandler';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import type { GitHubPushPayload } from '@bike4mind/server-utils/integrations/github/types';

function createPushPayload(): GitHubPushPayload {
  return {
    ref: 'refs/heads/main',
    before: 'abc',
    after: 'def',
    created: false,
    deleted: false,
    forced: false,
    compare: 'https://github.com/owner/repo/compare/abc...def',
    commits: [
      {
        id: 'def',
        message: 'Test commit',
        timestamp: '2024-01-01T00:00:00Z',
        url: 'https://github.com/owner/repo/commit/def',
        author: { name: 'Pusher', email: 'p@example.com', username: 'pusher-user' },
        committer: { name: 'Pusher', email: 'p@example.com', username: 'pusher-user' },
        added: [],
        removed: [],
        modified: [],
      },
    ],
    head_commit: null,
    pusher: { name: 'pusher-user', email: 'p@example.com' },
    repository: { full_name: 'owner/repo' },
    sender: { login: 'pusher-user' },
  } as GitHubPushPayload;
}

describe('PushHandler', () => {
  let handler: PushHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    mockFindByOrgAndRepo.mockResolvedValue([]);
    mockAccounts.mockResolvedValue([]);
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new PushHandler(notifier);
  });

  describe('subscriber-lookup failure', () => {
    it('surfaces notificationDispatchError when findByOrgAndRepo rejects', async () => {
      mockFindByOrgAndRepo.mockRejectedValue(new Error('Mongo timeout'));

      const result = await handler.handle(createPushPayload(), undefined, { orgId: 'org-123' });

      expect(result.notificationDispatchError).toBe('Subscriber lookup failed: Mongo timeout');
      expect(result.notifiedUserIds).toEqual([]);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('surfaces notificationDispatchError when OAuth account lookup rejects', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([{ userId: 'user-1', events: [], enabled: true }]);
      mockAccounts.mockRejectedValue(new Error('Replica failover'));

      const result = await handler.handle(createPushPayload(), undefined, { orgId: 'org-123' });

      expect(result.notificationDispatchError).toBe('Subscriber lookup failed: Replica failover');
      expect(result.notifiedUserIds).toEqual([]);
    });

    it('does not set notificationDispatchError on the happy path', async () => {
      mockFindByOrgAndRepo.mockResolvedValue([{ userId: 'user-1', events: [], enabled: true }]);
      mockAccounts.mockResolvedValue([{ metadata: { githubLogin: 'subscriber1' } }]);

      const result = await handler.handle(createPushPayload(), undefined, { orgId: 'org-123' });

      expect(result.notificationDispatchError).toBeUndefined();
      expect(mockAccounts).toHaveBeenCalledWith({ userIds: ['user-1'] });
      expect(mockNotify).toHaveBeenCalledWith('pushCommits', ['subscriber1'], expect.any(Function), {
        orgId: 'org-123',
      });
    });
  });
});
