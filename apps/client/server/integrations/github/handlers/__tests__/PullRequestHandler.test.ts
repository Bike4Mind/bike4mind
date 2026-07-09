import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoist mock functions to avoid initialization issues
const { mockNotify, mockSetFixVerdict, mockFindByPrNumber, mockUpdateStatus, mockCreateInboxMessage } = vi.hoisted(
  () => ({
    mockNotify: vi.fn(),
    mockSetFixVerdict: vi.fn(),
    mockFindByPrNumber: vi.fn(),
    mockUpdateStatus: vi.fn(),
    mockCreateInboxMessage: vi.fn(),
  })
);

vi.mock('@bike4mind/slack', () => ({
  GitHubSlackNotifier: vi.fn().mockImplementation(function () {
    return { notify: mockNotify };
  }),
  buildPROpenedBlocks: vi.fn().mockReturnValue({ text: 'opened', blocks: [] }),
  buildPRMergedBlocks: vi.fn().mockReturnValue({ text: 'merged', blocks: [] }),
  buildReviewRequestedBlocks: vi.fn().mockReturnValue({ text: 'review', blocks: [] }),
}));

vi.mock('@bike4mind/database', () => ({
  sreErrorTrackingRepository: {
    setFixVerdict: mockSetFixVerdict,
    findByPrNumber: mockFindByPrNumber,
    updateStatus: mockUpdateStatus,
  },
  inboxRepository: {
    createInboxMessage: mockCreateInboxMessage,
  },
}));

import { PullRequestHandler } from '../PullRequestHandler';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import type { GitHubPullRequestPayload } from '../../types';

function createLabeledPayload(
  overrides: Partial<{
    labelName: string;
    prNumber: number;
    branchRef: string;
    sender: string;
  }> = {}
): GitHubPullRequestPayload {
  return {
    action: 'labeled',
    repository: { full_name: 'owner/repo' },
    sender: { login: overrides.sender ?? 'reviewer-user' },
    number: overrides.prNumber ?? 42,
    label: { name: overrides.labelName ?? 'sre-fix-correct' },
    pull_request: {
      number: overrides.prNumber ?? 42,
      title: 'fix(sre): autofix',
      html_url: 'https://github.com/owner/repo/pull/42',
      user: { login: 'sre-agent[bot]', id: 1, html_url: '' },
      merged: false,
      head: { ref: overrides.branchRef ?? 'sre-fix/abc123', sha: 'sha123' },
      base: { ref: 'main' },
    },
  } as GitHubPullRequestPayload;
}

describe('PullRequestHandler - labeled (SRE fix verdict, #271)', () => {
  let handler: PullRequestHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    mockSetFixVerdict.mockResolvedValue({ id: 'tracking-1', fixPrNumber: 42 });
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new PullRequestHandler(notifier);
  });

  it('maps sre-fix-correct on an SRE PR to a "correct" verdict keyed by PR number', async () => {
    await handler.handle(createLabeledPayload({ labelName: 'sre-fix-correct', prNumber: 77, sender: 'alice' }));

    expect(mockSetFixVerdict).toHaveBeenCalledTimes(1);
    expect(mockSetFixVerdict).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ value: 'correct', by: 'alice', at: expect.any(Date) })
    );
  });

  it('maps sre-fix-incorrect to an "incorrect" verdict (opposite label overrides via last-write-wins)', async () => {
    await handler.handle(createLabeledPayload({ labelName: 'sre-fix-incorrect', prNumber: 77 }));

    expect(mockSetFixVerdict).toHaveBeenCalledWith(77, expect.objectContaining({ value: 'incorrect' }));
  });

  it('ignores non-verdict labels (no persistence)', async () => {
    await handler.handle(createLabeledPayload({ labelName: 'bug' }));
    expect(mockSetFixVerdict).not.toHaveBeenCalled();
  });

  it('ignores verdict labels on non-SRE PRs (branch is not sre-fix/*)', async () => {
    await handler.handle(createLabeledPayload({ labelName: 'sre-fix-correct', branchRef: 'feat/some-feature' }));
    expect(mockSetFixVerdict).not.toHaveBeenCalled();
  });

  it('does not throw when no tracking doc exists for the SRE PR', async () => {
    mockSetFixVerdict.mockResolvedValueOnce(null);
    await expect(handler.handle(createLabeledPayload({ labelName: 'sre-fix-correct' }))).resolves.toBeDefined();
    expect(mockSetFixVerdict).toHaveBeenCalledTimes(1);
  });

  it('does not throw when persistence rejects', async () => {
    mockSetFixVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.handle(createLabeledPayload({ labelName: 'sre-fix-correct' }))).resolves.toBeDefined();
  });
});
