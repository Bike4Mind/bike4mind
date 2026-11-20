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

/**
 * Recounts a job's sent/failed/cancelled totals from its attempts and, once none is in flight,
 * completes it. A recount rather than an increment, so the email-send worker's outcome landing
 * after the batch finished still converges to the right counts and overallStatus.
 */
export async function reconcileEmailJob(jobId: string): Promise<void> {
  const job = await emailJobRepository.findById(jobId);
  if (!job) return;

  const [inFlight, sentCount, failedCount, cancelledCount] = await Promise.all([
    emailSendAttemptRepository.count({ jobId, status: { $in: IN_FLIGHT_STATUSES } }),
    emailSendAttemptRepository.count({ jobId, status: { $in: SENT_STATUSES } }),
    emailSendAttemptRepository.count({ jobId, status: { $in: FAILED_STATUSES } }),
    emailSendAttemptRepository.count({ jobId, status: EmailSendStatus.CANCELLED }),
  ]);

  const counts = { sentCount, failedCount, cancelledCount };
  if (inFlight > 0 || job.status === EmailJobStatus.CANCELLED) {
    await emailJobRepository.update({ id: jobId, ...counts });
    return;
  }

  let overallStatus: EmailJobOverallStatus;
  if (failedCount === 0 && cancelledCount === 0) overallStatus = EmailJobOverallStatus.COMPLETE;
  else if (sentCount === 0) overallStatus = EmailJobOverallStatus.FAILED;
  else overallStatus = EmailJobOverallStatus.PARTIAL;

  await emailJobRepository.update({
    id: jobId,
    ...counts,
    status: EmailJobStatus.COMPLETED,
    overallStatus,
    completedAt: job.completedAt ?? new Date(),
  });
}
