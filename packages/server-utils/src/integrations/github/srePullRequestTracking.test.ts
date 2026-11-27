import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSetFixVerdict, mockFindByPrNumber, mockUpdateStatus, mockCreateInboxMessage } = vi.hoisted(() => ({
  mockSetFixVerdict: vi.fn(),
  mockFindByPrNumber: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockCreateInboxMessage: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  sreErrorTrackingRepository: {
    setFixVerdict: mockSetFixVerdict,
    findByPrNumber: mockFindByPrNumber,
    updateStatus: mockUpdateStatus,
  },
  inboxRepository: { createInboxMessage: mockCreateInboxMessage },
}));

import type { Logger } from '@bike4mind/observability';
import { recordSrePullRequestEvent } from './srePullRequestTracking';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function payload(
  overrides: Partial<{ action: string; labelName: string; branchRef: string; merged: boolean; sender: string }> = {}
) {
  return {
    action: overrides.action ?? 'labeled',
    label: { name: overrides.labelName ?? 'sre-fix-correct' },
    sender: { login: overrides.sender ?? 'reviewer' },
    pull_request: {
      number: 77,
      merged: overrides.merged ?? false,
      head: { ref: overrides.branchRef ?? 'sre-fix/abc123' },
    },
    repository: { full_name: 'owner/repo' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetFixVerdict.mockResolvedValue({ id: 'tracking-1' });
  mockFindByPrNumber.mockResolvedValue({ id: 'tracking-1', affectedUserIds: ['u1', 'u2'], errorMessage: 'boom' });
  mockUpdateStatus.mockResolvedValue(undefined);
  mockCreateInboxMessage.mockResolvedValue(undefined);
});

describe('recordSrePullRequestEvent - verdict labels', () => {
  it('records sre-fix-correct scoped by PR number and repo', async () => {
    const result = await recordSrePullRequestEvent(payload({ sender: 'alice' }), logger);

    expect(result).toEqual({ recorded: true });
    expect(mockSetFixVerdict).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ value: 'correct', by: 'alice', at: expect.any(Date) }),
      'owner/repo'
    );
  });

  it('records sre-fix-incorrect', async () => {
    await recordSrePullRequestEvent(payload({ labelName: 'sre-fix-incorrect' }), logger);
    expect(mockSetFixVerdict).toHaveBeenCalledWith(77, expect.objectContaining({ value: 'incorrect' }), 'owner/repo');
  });

  it('ignores non-verdict labels and non-SRE branches', async () => {
    await recordSrePullRequestEvent(payload({ labelName: 'bug' }), logger);
    await recordSrePullRequestEvent(payload({ branchRef: 'feat/x' }), logger);
    expect(mockSetFixVerdict).not.toHaveBeenCalled();
  });

  it('rejects a payload without a repository', async () => {
    const { repository: _repository, ...rest } = payload();
    const result = await recordSrePullRequestEvent(rest, logger);
    expect(result).toEqual({ recorded: false, reason: 'invalid_payload' });
    expect(mockSetFixVerdict).not.toHaveBeenCalled();
  });

  it('does not throw when persistence rejects', async () => {
    mockSetFixVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(recordSrePullRequestEvent(payload(), logger)).resolves.toEqual({ recorded: false, reason: 'error' });
  });
});

describe('recordSrePullRequestEvent - merged fix', () => {
  it('notifies affected users and marks the tracking doc fixed', async () => {
    const result = await recordSrePullRequestEvent(payload({ action: 'closed', merged: true }), logger);

    expect(result).toEqual({ recorded: true });
    expect(mockFindByPrNumber).toHaveBeenCalledWith(77, 'owner/repo');
    expect(mockCreateInboxMessage).toHaveBeenCalledTimes(2);
    expect(mockUpdateStatus).toHaveBeenCalledWith('tracking-1', 'fixed', expect.any(Object));
  });

  it('does nothing for a closed but unmerged PR', async () => {
    await recordSrePullRequestEvent(payload({ action: 'closed', merged: false }), logger);
    expect(mockFindByPrNumber).not.toHaveBeenCalled();
  });
});
