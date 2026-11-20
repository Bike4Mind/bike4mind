import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailJobOverallStatus, EmailJobStatus, EmailSendStatus } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findJob: vi.fn(), updateCounts: vi.fn(), completeRun: vi.fn(), count: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  emailJobRepository: { findById: mocks.findJob, updateCounts: mocks.updateCounts, completeRun: mocks.completeRun },
  emailSendAttemptRepository: { count: mocks.count },
}));

import { reconcileEmailJob } from './reconcileEmailJob';

type CountFilter = { status?: EmailSendStatus | { $in: EmailSendStatus[] }; createdAt?: unknown };

// Counts the statuses a filter names in a fixed attempt list, the way countDocuments would.
function withAttempts(statuses: EmailSendStatus[], currentRunAttempts = statuses.length) {
  mocks.count.mockImplementation(async ({ status, createdAt }: CountFilter) => {
    if (!status) return createdAt ? currentRunAttempts : statuses.length;
    const wanted = typeof status === 'string' ? [status] : status.$in;
    return statuses.filter(s => wanted.includes(s)).length;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.PROCESSING });
  mocks.completeRun.mockResolvedValue(true);
  mocks.updateCounts.mockResolvedValue(true);
});

describe('reconcileEmailJob', () => {
  it('completes a job whose attempts are all queued or sent', async () => {
    withAttempts([EmailSendStatus.QUEUED, EmailSendStatus.OPENED]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).toHaveBeenCalledWith(
      'job-1',
      undefined,
      undefined,
      expect.objectContaining({ sentCount: 2, failedCount: 0, overallStatus: EmailJobOverallStatus.COMPLETE })
    );
    expect(mocks.updateCounts).not.toHaveBeenCalled();
  });

  it('turns a completed job PARTIAL when a late worker result fails one attempt, keeping its completedAt', async () => {
    const completedAt = new Date('2026-01-01T00:00:00Z');
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.COMPLETED, completedAt });
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.FAILED]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).toHaveBeenCalledWith(
      'job-1',
      undefined,
      undefined,
      expect.objectContaining({
        sentCount: 1,
        failedCount: 1,
        overallStatus: EmailJobOverallStatus.PARTIAL,
        completedAt,
      })
    );
  });

  it('stamps a fresh completedAt when a rerun finishes', async () => {
    const completedAt = new Date('2026-01-01T00:00:00Z');
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.PROCESSING, completedAt });
    withAttempts([EmailSendStatus.SENT]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun.mock.calls[0][3].completedAt).not.toBe(completedAt);
  });

  it('marks the job FAILED when nothing was sent', async () => {
    withAttempts([EmailSendStatus.FAILED, EmailSendStatus.BOUNCED]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).toHaveBeenCalledWith(
      'job-1',
      undefined,
      undefined,
      expect.objectContaining({ overallStatus: EmailJobOverallStatus.FAILED })
    );
  });

  it('only updates counts while an attempt is still pending', async () => {
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.PENDING]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.updateCounts).toHaveBeenCalledWith('job-1', undefined, {
      sentCount: 1,
      failedCount: 0,
      cancelledCount: 0,
    });
  });

  it('never moves a cancelled job back to completed', async () => {
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.CANCELLED });
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.CANCELLED]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.updateCounts).toHaveBeenCalledWith('job-1', undefined, {
      sentCount: 1,
      failedCount: 0,
      cancelledCount: 1,
    });
  });

  it('falls back to a counts-only write when the conditional completion does not match', async () => {
    mocks.completeRun.mockResolvedValue(false);
    withAttempts([EmailSendStatus.SENT]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateCounts).toHaveBeenCalledWith('job-1', undefined, {
      sentCount: 1,
      failedCount: 0,
      cancelledCount: 0,
    });
  });

  it('does not close a newer send that has no attempts yet', async () => {
    const lastSentAt = new Date('2026-01-05T00:00:00Z');
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.COMPLETED, lastSentAt });
    withAttempts([EmailSendStatus.SENT], 0);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.count).toHaveBeenCalledWith({ jobId: 'job-1', createdAt: { $gte: lastSentAt } });
  });

  it('reads and writes again when another recount advanced the job version first', async () => {
    let statuses = [EmailSendStatus.SENT, EmailSendStatus.PROCESSING];
    mocks.count.mockImplementation(async ({ status }: CountFilter) => {
      if (!status) return statuses.length;
      const wanted = typeof status === 'string' ? [status] : status.$in;
      return statuses.filter(s => wanted.includes(s)).length;
    });
    mocks.findJob
      .mockResolvedValueOnce({ id: 'job-1', status: EmailJobStatus.PROCESSING, __v: 4 })
      .mockResolvedValue({ id: 'job-1', status: EmailJobStatus.PROCESSING, __v: 5 });
    mocks.updateCounts.mockImplementationOnce(async () => {
      statuses = [EmailSendStatus.SENT, EmailSendStatus.FAILED];
      return false;
    });
    await reconcileEmailJob('job-1');
    expect(mocks.updateCounts).toHaveBeenCalledExactlyOnceWith('job-1', 4, {
      sentCount: 1,
      failedCount: 0,
      cancelledCount: 0,
    });
    expect(mocks.completeRun).toHaveBeenCalledExactlyOnceWith(
      'job-1',
      undefined,
      5,
      expect.objectContaining({ sentCount: 1, failedCount: 1, overallStatus: EmailJobOverallStatus.PARTIAL })
    );
  });

  it('writes once when no other recount raced it', async () => {
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.FAILED]);
    await reconcileEmailJob('job-1');
    expect(mocks.completeRun).toHaveBeenCalledTimes(1);
    expect(mocks.findJob).toHaveBeenCalledTimes(1);
  });
});
