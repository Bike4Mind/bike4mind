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
import type { GitHubPullRequestPayload } from '@bike4mind/server-utils/integrations/github/types';

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

describe('PullRequestHandler - SRE tracking docs', () => {
  let handler: PullRequestHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    mockFindByPrNumber.mockResolvedValue({ id: 'tracking-1', affectedUserIds: ['u1'], errorMessage: 'boom' });
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new PullRequestHandler(notifier);
  });

  it('does not record a verdict from a tenant webhook', async () => {
    await handler.handle(createLabeledPayload({ labelName: 'sre-fix-correct', prNumber: 77 }), undefined, {
      orgId: 'org-1',
    });
    expect(mockSetFixVerdict).not.toHaveBeenCalled();
  });

  it('notifies on a merged sre-fix PR without touching its tracking doc', async () => {
    const payload = createLabeledPayload();
    payload.action = 'closed';
    payload.pull_request.merged = true;
    payload.pull_request.merged_by = { login: 'merger' } as never;

    await handler.handle(payload, undefined, { orgId: 'org-1' });

    expect(mockNotify).toHaveBeenCalledWith('prMerged', ['sre-agent[bot]'], expect.any(Function), { orgId: 'org-1' });
    expect(mockFindByPrNumber).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockCreateInboxMessage).not.toHaveBeenCalled();
  });
});
