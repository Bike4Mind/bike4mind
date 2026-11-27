import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { EmailJobOverallStatus, EmailJobStatus, EmailSendStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

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

// Each lost race means another recount wrote meanwhile; this only bounds a pathological storm.
const MAX_ATTEMPTS = 10;

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

/**
 * Recounts a job's sent/failed/cancelled totals from its attempts and, once none is in flight,
 * completes it. A recount rather than an increment, so the email-send worker's outcome landing
 * after the batch finished still converges to the right counts and overallStatus. Every write is
 * conditioned on the job version read before the recount, so a recount that read older attempts
 * than a concurrent one cannot overwrite it; the loser reads again. Completion never overrides a
 * cancel, and never closes a newer send claimed (lastSentAt) before its attempts exist.
 */
export async function reconcileEmailJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const job = await emailJobRepository.findById(jobId);
    if (!job) return;
    const version = (job as { __v?: number }).__v;
    const current = await recount(jobId, job.lastSentAt);
    const { sentCount, failedCount, cancelledCount } = current;
    const counts = { sentCount, failedCount, cancelledCount };

    if (current.inFlight === 0 && current.currentRunAttempts > 0 && job.status !== EmailJobStatus.CANCELLED) {
      let overallStatus: EmailJobOverallStatus;
      if (failedCount === 0 && cancelledCount === 0) overallStatus = EmailJobOverallStatus.COMPLETE;
      else if (sentCount === 0) overallStatus = EmailJobOverallStatus.FAILED;
      else overallStatus = EmailJobOverallStatus.PARTIAL;

      // A rerun moves status off COMPLETED (orchestrator), so a fresh stamp marks each run's end.
      const completedAt = job.status === EmailJobStatus.COMPLETED && job.completedAt ? job.completedAt : new Date();
      const completed = await emailJobRepository.completeRun(jobId, job.lastSentAt, version, {
        ...counts,
        overallStatus,
        completedAt,
      });
      if (completed) return;
    }
    // Also reached when completion was refused by a cancel or a newer claim: the counts still land.
    if (await emailJobRepository.updateCounts(jobId, version, counts)) return;
  }
  Logger.warn(`Email job ${jobId} recount lost ${MAX_ATTEMPTS} write races; the next recount corrects it`);
}
