import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailJobOverallStatus, EmailJobStatus, EmailSendStatus } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findJob: vi.fn(), updateJob: vi.fn(), count: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  emailJobRepository: { findById: mocks.findJob, update: mocks.updateJob },
  emailSendAttemptRepository: { count: mocks.count },
}));

import { reconcileEmailJob } from './reconcileEmailJob';

// Counts the statuses a filter names in a fixed attempt list, the way countDocuments would.
function withAttempts(statuses: EmailSendStatus[]) {
  mocks.count.mockImplementation(async ({ status }: { status: EmailSendStatus | { $in: EmailSendStatus[] } }) => {
    const wanted = typeof status === 'string' ? [status] : status.$in;
    return statuses.filter(s => wanted.includes(s)).length;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.PROCESSING });
});

describe('reconcileEmailJob', () => {
  it('completes a job whose attempts are all queued or sent', async () => {
    withAttempts([EmailSendStatus.QUEUED, EmailSendStatus.OPENED]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sentCount: 2,
        failedCount: 0,
        status: EmailJobStatus.COMPLETED,
        overallStatus: EmailJobOverallStatus.COMPLETE,
      })
    );
  });

  it('turns a completed job PARTIAL when a late worker result fails one attempt', async () => {
    const completedAt = new Date('2026-01-01T00:00:00Z');
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.COMPLETED, completedAt });
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.FAILED]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sentCount: 1,
        failedCount: 1,
        overallStatus: EmailJobOverallStatus.PARTIAL,
        completedAt,
      })
    );
  });

  it('writes the same counts and status when run again on unchanged attempts', async () => {
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.FAILED]);
    await reconcileEmailJob('job-1');
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledTimes(2);
    const expected = { sentCount: 1, failedCount: 1, overallStatus: EmailJobOverallStatus.PARTIAL };
    expect(mocks.updateJob.mock.calls[0][0]).toMatchObject(expected);
    expect(mocks.updateJob.mock.calls[1][0]).toMatchObject(expected);
  });

  it('marks the job FAILED when nothing was sent', async () => {
    withAttempts([EmailSendStatus.FAILED, EmailSendStatus.BOUNCED]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledWith(
      expect.objectContaining({ overallStatus: EmailJobOverallStatus.FAILED })
    );
  });

  it('only updates counts while an attempt is still pending', async () => {
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.PENDING]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledWith({ id: 'job-1', sentCount: 1, failedCount: 0, cancelledCount: 0 });
  });

  it('never moves a cancelled job back to completed', async () => {
    mocks.findJob.mockResolvedValue({ id: 'job-1', status: EmailJobStatus.CANCELLED });
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.CANCELLED]);
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob).toHaveBeenCalledWith({ id: 'job-1', sentCount: 1, failedCount: 0, cancelledCount: 1 });
  });

  it('gives the same result when run twice', async () => {
    withAttempts([EmailSendStatus.SENT, EmailSendStatus.FAILED]);
    await reconcileEmailJob('job-1');
    await reconcileEmailJob('job-1');
    expect(mocks.updateJob.mock.calls[1][0]).toEqual({
      ...mocks.updateJob.mock.calls[0][0],
      completedAt: expect.any(Date),
    });
  });
});
