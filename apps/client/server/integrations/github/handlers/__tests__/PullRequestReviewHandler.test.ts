import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist mock functions
const { mockNotify } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
}));

vi.mock('@bike4mind/slack', () => ({
  GitHubSlackNotifier: vi.fn().mockImplementation(function () {
    return { notify: mockNotify };
  }),
  buildPRApprovedBlocks: vi.fn().mockReturnValue({ text: 'approved', blocks: [] }),
  buildPRChangesRequestedBlocks: vi.fn().mockReturnValue({ text: 'changes', blocks: [] }),
}));

import { PullRequestReviewHandler } from '../PullRequestReviewHandler';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import type { GitHubPullRequestReviewPayload } from '../../types';

function createReviewPayload(
  overrides: Partial<{
    action: string;
    state: string;
    prNumber: number;
    reviewer: string;
    prAuthor: string;
    branchRef: string;
    reviewBody: string;
  }> = {}
): GitHubPullRequestReviewPayload {
  return {
    action: overrides.action ?? 'submitted',
    repository: { full_name: 'owner/repo' },
    sender: { login: overrides.reviewer ?? 'reviewer-user' },
    review: {
      id: 1,
      state: overrides.state ?? 'changes_requested',
      user: { login: overrides.reviewer ?? 'reviewer-user', id: 100, html_url: '' },
      html_url: 'https://github.com/owner/repo/pull/42#review-1',
      body: overrides.reviewBody ?? 'Please fix the null check',
    },
    pull_request: {
      number: overrides.prNumber ?? 42,
      title: 'fix(sre): autofix — test fix',
      html_url: 'https://github.com/owner/repo/pull/42',
      user: { login: overrides.prAuthor ?? 'sre-agent[bot]', id: 200, html_url: '' },
      head: overrides.branchRef !== undefined ? { ref: overrides.branchRef, sha: 'abc123' } : undefined,
    },
  } as GitHubPullRequestReviewPayload;
}

describe('PullRequestReviewHandler', () => {
  let handler: PullRequestReviewHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new PullRequestReviewHandler(notifier);
  });

  it('notifies PR author on changes_requested', async () => {
    const payload = createReviewPayload({ branchRef: 'feat/some-feature' });
    await handler.handle(payload);
    expect(mockNotify).toHaveBeenCalledWith('prChangesRequested', ['sre-agent[bot]'], expect.any(Function), {
      orgId: undefined,
    });
  });

  it('notifies PR author on approved', async () => {
    const payload = createReviewPayload({ state: 'approved' });
    await handler.handle(payload);
    expect(mockNotify).toHaveBeenCalledWith('prApproved', ['sre-agent[bot]'], expect.any(Function), {
      orgId: undefined,
    });
  });

  it('skips notification when reviewer is PR author', async () => {
    const payload = createReviewPayload({ reviewer: 'same-user', prAuthor: 'same-user' });
    await handler.handle(payload);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('ignores non-submitted actions', async () => {
    const payload = createReviewPayload({ action: 'edited' });
    await handler.handle(payload);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // Notification failures must surface as Failed deliveries, not Skipped.
  describe('notification failure propagation', () => {
    it('propagates per-user failures from notifier', async () => {
      mockNotify.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [{ userId: 'user-1', error: 'channel_not_found' }],
      });

      const payload = createReviewPayload({ state: 'changes_requested' });
      const result = await handler.handle(payload);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.failedNotifications).toEqual([{ userId: 'user-1', error: 'channel_not_found' }]);
    });

    it('propagates dispatchError from notifier', async () => {
      mockNotify.mockResolvedValue({
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: 'Subscription check failed: Mongo connection lost',
      });

      const payload = createReviewPayload({ state: 'approved' });
      const result = await handler.handle(payload);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.notificationDispatchError).toBe('Subscription check failed: Mongo connection lost');
    });

    it('does NOT rethrow when notifier throws — captures as dispatchError', async () => {
      mockNotify.mockRejectedValue(new Error('Mongoose pool exhausted'));

      const payload = createReviewPayload({ state: 'changes_requested' });
      const result = await handler.handle(payload);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.notificationDispatchError).toBe('Notifier threw: Mongoose pool exhausted');
    });

    it('omits failure fields when notify returns cleanly with zero recipients', async () => {
      mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });

      const payload = createReviewPayload({ state: 'changes_requested' });
      const result = await handler.handle(payload);

      expect(result).toEqual({ notifiedUserIds: [] });
    });
  });
});
