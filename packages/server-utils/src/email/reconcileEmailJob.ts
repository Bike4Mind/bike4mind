import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailJobOverallStatus, EmailJobStatus, EmailSendStatus } from '@bike4mind/common';

// Must stay in sync with getJobSummary in packages/database/src/models/infra/email/EmailSendAttemptModel.ts.
const SENT_STATUSES = [
  EmailSendStatus.QUEUED,
  EmailSendStatus.SENT,
  EmailSendStatus.DELIVERED,
  EmailSendStatus.OPENED,
  EmailSendStatus.CLICKED,
];
const FAILED_STATUSES = [EmailSendStatus.FAILED, EmailSendStatus.BOUNCED];
const IN_FLIGHT_STATUSES = [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING];

const MAX_PASSES = 3;

interface Recount {
  inFlight: number;
  currentRunAttempts: number;
  sentCount: number;
  failedCount: number;
  cancelledCount: number;
}

async function recount(jobId: string, runStartedAt: Date | undefined): Promise<Recount> {
  const [inFlight, currentRunAttempts, sentCount, failedCount, cancelledCount] = await Promise.all([
    emailSendAttemptRepository.count({ jobId, status: { $in: IN_FLIGHT_STATUSES } }),
    emailSendAttemptRepository.count(runStartedAt ? { jobId, createdAt: { $gte: runStartedAt } } : { jobId }),
    emailSendAttemptRepository.count({ jobId, status: { $in: SENT_STATUSES } }),
    emailSendAttemptRepository.count({ jobId, status: { $in: FAILED_STATUSES } }),
    emailSendAttemptRepository.count({ jobId, status: EmailSendStatus.CANCELLED }),
  ]);
  return { inFlight, currentRunAttempts, sentCount, failedCount, cancelledCount };
}

const sameRecount = (a: Recount, b: Recount) => (Object.keys(a) as (keyof Recount)[]).every(key => a[key] === b[key]);

/**
 * Recounts a job's sent/failed/cancelled totals from its attempts and, once none is in flight,
 * completes it. A recount rather than an increment, so the email-send worker's outcome landing
 * after the batch finished still converges to the right counts and overallStatus. Concurrent
 * callers converge because each recounts after its own write and writes again on a change.
 * Completion never overrides a cancel, and never closes a newer send claimed (lastSentAt) before
 * its attempts exist.
 */
export async function reconcileEmailJob(jobId: string): Promise<void> {
  let job = await emailJobRepository.findById(jobId);
  if (!job) return;
  let current = await recount(jobId, job.lastSentAt);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { sentCount, failedCount, cancelledCount } = current;
    const counts = { sentCount, failedCount, cancelledCount };
    const canComplete =
      current.inFlight === 0 && current.currentRunAttempts > 0 && job.status !== EmailJobStatus.CANCELLED;

    let completed = false;
    if (canComplete) {
      let overallStatus: EmailJobOverallStatus;
      if (failedCount === 0 && cancelledCount === 0) overallStatus = EmailJobOverallStatus.COMPLETE;
      else if (sentCount === 0) overallStatus = EmailJobOverallStatus.FAILED;
      else overallStatus = EmailJobOverallStatus.PARTIAL;

      // A rerun moves status off COMPLETED (orchestrator), so a fresh stamp marks each run's end.
      const completedAt = job.status === EmailJobStatus.COMPLETED && job.completedAt ? job.completedAt : new Date();
      completed = await emailJobRepository.completeRun(jobId, job.lastSentAt, {
        ...counts,
        overallStatus,
        completedAt,
      });
    }
    if (!completed) await emailJobRepository.update({ id: jobId, ...counts });

    job = await emailJobRepository.findById(jobId);
    if (!job) return;
    const next = await recount(jobId, job.lastSentAt);
    if (sameRecount(current, next)) return;
    current = next;
  }
}
