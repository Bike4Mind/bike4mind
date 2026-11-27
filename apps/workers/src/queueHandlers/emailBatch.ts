import {
  emailJobRepository,
  emailSendAttemptRepository,
  emailTemplateRepository,
  userRepository,
  subscriberRepository,
} from '@bike4mind/database';
import {
  EmailJobStatus,
  EmailSendStatus,
  IEmailTemplateDocument,
  IEmailSendAttemptDocument,
  requireEnv,
} from '@bike4mind/common';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { queuedMailer } from '@bike4mind/server-utils/utils/mailer/queuedMailer';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { reconcileEmailJob } from '@bike4mind/server-utils/email/reconcileEmailJob';
import { SQSBatchResponse } from 'aws-lambda';
import { z } from 'zod';

const BatchPayload = z.object({
  jobId: z.string(),
  attemptIds: z.array(z.string()),
  templateId: z.string(),
  batchIndex: z.number().optional(),
  totalBatches: z.number().optional(),
});

// Process emails in parallel chunks to avoid overwhelming the mailer
const PARALLEL_SEND_SIZE = 5;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000; // 1 second delay between retries
// An attempt's send lease (ms). Longer than the emailBatchQueue Lambda timeout, and the queue's visibility
// timeout must cover timeout + lease (both in infra/emailMarketing.ts).
export const SEND_LEASE_MS = 150_000;

type AttemptOutcome = 'sent' | 'failed' | 'busy' | 'skipped';

export const dispatch = dispatchWithLogger<SQSBatchResponse>(async (event, context, logger) => {
  // Process all SQS records in this invocation (supports batch processing). The queue is
  // subscribed with batch.partialResponses: true, so a per-record failure is reported here
  // instead of swallowed, letting SQS retry/DLQ just that record.
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);
      const { jobId, attemptIds, templateId, batchIndex, totalBatches } = BatchPayload.parse(body);

      logger.updateMetadata({
        jobId,
        batchSize: attemptIds.length,
        batchIndex: batchIndex ?? 0,
        totalBatches: totalBatches ?? 1,
      });
      logger.info(`Processing email batch ${(batchIndex ?? 0) + 1}/${totalBatches ?? 1}`);

      const job = await emailJobRepository.findById(jobId);
      if (!job) {
        logger.error('Job not found');
        continue;
      }

      if (job.status === EmailJobStatus.CANCELLED) {
        logger.info('Job was cancelled, skipping batch');
        continue;
      }

      const template = await emailTemplateRepository.findById(templateId);
      if (!template) {
        logger.error('Template not found');
        continue;
      }

      // Fetch all attempts upfront for efficiency
      const attempts = await Promise.all(attemptIds.map(id => emailSendAttemptRepository.findById(id)));

      // PROCESSING is included so a redelivery finishes what a crashed or failed invocation left;
      // claimForSend decides whether it may be sent again.
      const openAttempts = attempts.filter(
        (a): a is IEmailSendAttemptDocument =>
          a !== null && (a.status === EmailSendStatus.PENDING || a.status === EmailSendStatus.PROCESSING)
      );

      if (openAttempts.length === 0) {
        logger.info('No pending attempts in this batch, skipping');
        continue;
      }

      logger.info(`Processing ${openAttempts.length} pending emails`);

      let sentCount = 0;
      let failedCount = 0;
      let unresolvedCount = 0;

      for (let i = 0; i < openAttempts.length; i += PARALLEL_SEND_SIZE) {
        const chunk = openAttempts.slice(i, i + PARALLEL_SEND_SIZE);

        const results = await Promise.allSettled(chunk.map(attempt => processAttempt(attempt, job, template, logger)));

        for (const result of results) {
          if (result.status === 'rejected') {
            logger.error(`Email attempt left unresolved: ${errorMessage(result.reason)}`);
            unresolvedCount++;
          } else if (result.value === 'sent') {
            sentCount++;
          } else if (result.value === 'failed') {
            failedCount++;
          } else if (result.value === 'busy') {
            unresolvedCount++;
          }
        }
      }

      logger.info(
        `Batch ${(batchIndex ?? 0) + 1} complete: ${sentCount} queued, ${failedCount} failed, ${unresolvedCount} unresolved`
      );

      await reconcileEmailJob(jobId);

      if (unresolvedCount > 0) {
        // Redelivery picks the unresolved attempts up again (see claimForSend).
        throw new Error(`${unresolvedCount} attempt(s) unresolved in this batch`);
      }
    } catch (error) {
      logger.error('Failed to process batch record', error);
      // Report this record as failed so SQS retries/DLQs it; keep processing the rest.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
});

/**
 * Sends one attempt at most once per claim. Only the mailer call is retried: once the mailer has
 * accepted the mail, a failing status write is retried on its own and never triggers another send.
 * Rejects when the attempt is left PROCESSING, so the SQS record fails and is redelivered.
 */
async function processAttempt(
  attempt: IEmailSendAttemptDocument,
  job: { variables?: Record<string, string> },
  template: IEmailTemplateDocument,
  logger: { error: (msg: string) => void; info: (msg: string) => void }
): Promise<AttemptOutcome> {
  const startRetryCount = attempt.retryCount || 0;

  // An earlier invocation got the mail accepted but could not write its status: finish that write.
  if (attempt.status === EmailSendStatus.PROCESSING && attempt.sendAccepted?.at) {
    await recordAccepted(attempt.id, attempt.sendAccepted, startRetryCount);
    return 'sent';
  }

  // Render once, outside the retry loop. In test mode, personalize with originalRecipient
  // (so {{userEmail}} shows the real recipient) but the email is actually sent to
  // attempt.recipientEmail (the test address).
  const emailForPersonalization = attempt.originalRecipient || attempt.recipientEmail;

  const recipientData = await getRecipientData(attempt.recipientId, attempt.recipientType);

  const rendered = renderTemplate(
    template,
    {
      ...Object.fromEntries(Object.entries(job.variables || {}).map(([k, v]) => [k, v])),
      recipientEmail: emailForPersonalization,
      userEmail: emailForPersonalization,
      userName: recipientData.name || emailForPersonalization.split('@')[0],
      userFirstName: recipientData.firstName || emailForPersonalization.split('@')[0],
      appName: process.env.APP_NAME || '', // no brand fallback
      date: new Date().toLocaleDateString(),
    },
    attempt.trackingToken
  );

  const finalSubject = attempt.testSubjectIndicator ? `[TEST] ${rendered.subject}` : rendered.subject;

  // Written before the publish because the worker's outcome write can land before markQueued.
  const now = new Date();
  const claimed = await emailSendAttemptRepository.claimForSend(attempt.id, {
    now,
    staleBefore: new Date(now.getTime() - SEND_LEASE_MS),
    renderedSubject: finalSubject,
    renderedHtml: rendered.html,
  });
  if (!claimed) {
    const current = await emailSendAttemptRepository.findById(attempt.id);
    if (current?.status === EmailSendStatus.PROCESSING) {
      logger.info(`Attempt ${attempt.id} is being sent by another invocation; leaving it to that one`);
      return 'busy';
    }
    return 'skipped';
  }

  let lastError: string = '';
  let accepted: { at: Date; queued: boolean } | null = null;
  let sendTries = 0;

  for (let retryAttempt = 0; retryAttempt < MAX_RETRY_ATTEMPTS; retryAttempt++) {
    sendTries = retryAttempt;
    try {
      const result = await queuedMailer.sendEmail(
        attempt.recipientEmail,
        { subject: finalSubject, html: rendered.html },
        { ref: { kind: 'emailAttempt', attemptId: attempt.id } }
      );
      if (!result) throw new Error('Mailer returned false');
      accepted = { at: new Date(), queued: 'queued' in result };
      break;
    } catch (error) {
      lastError = errorMessage(error);

      if (retryAttempt < MAX_RETRY_ATTEMPTS - 1) {
        logger.info(`Retry ${retryAttempt + 1}/${MAX_RETRY_ATTEMPTS} for ${attempt.recipientEmail}: ${lastError}`);
        await sleep(RETRY_DELAY_MS * (retryAttempt + 1)); // linear backoff
      }
    }
  }

  if (!accepted) {
    logger.error(`Failed to send to ${attempt.recipientEmail} after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError}`);
    await emailSendAttemptRepository.markSendFailed(attempt.id, {
      errorMessage: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError}`,
      retryCount: startRetryCount + MAX_RETRY_ATTEMPTS,
    });
    return 'failed';
  }

  if (sendTries > 0) {
    logger.info(`Email to ${attempt.recipientEmail} succeeded after ${sendTries} retries`);
  }

  try {
    await recordAccepted(attempt.id, accepted, startRetryCount + sendTries);
  } catch (error) {
    // Best effort: with the marker in place a redelivery finishes the status write without sending.
    const marked = await emailSendAttemptRepository.markSendAccepted(attempt.id, accepted).catch(() => false);
    throw new Error(
      `Status write failed after the mail was accepted (sent marker ${marked ? 'written' : 'not written'}): ` +
        errorMessage(error)
    );
  }
  return 'sent';
}

/** Writes the status for mail the mailer accepted, retrying the write alone. */
async function recordAccepted(
  attemptId: string,
  accepted: { at: Date; queued: boolean },
  retryCount: number
): Promise<void> {
  await withRetries(async () => {
    if (accepted.queued) {
      // The email-send worker writes SENT or FAILED (packages/server-utils/src/utils/mailer/deliveryOutcome.ts).
      await emailSendAttemptRepository.markQueued(attemptId, { sentAt: accepted.at, retryCount });
    } else {
      await emailSendAttemptRepository.recordDeliveryOutcome(attemptId, { ok: true, at: accepted.at }, { retryCount });
    }
  });
}

async function withRetries(write: () => Promise<void>): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await write();
    } catch (error) {
      if (i >= MAX_RETRY_ATTEMPTS - 1) throw error;
      await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch recipient data for personalization variables
 * Returns name and firstName for use in email templates
 */
async function getRecipientData(
  recipientId: string,
  recipientType: string
): Promise<{ name?: string; firstName?: string }> {
  try {
    if (recipientType === 'user') {
      const user = await userRepository.findById(recipientId);
      if (user) {
        const firstName = user.name?.split(' ')[0];
        return { name: user.name, firstName };
      }
    } else if (recipientType === 'subscriber') {
      const subscriber = await subscriberRepository.findById(recipientId);
      if (subscriber) {
        const fullName = [subscriber.firstName, subscriber.lastName].filter(Boolean).join(' ');
        return { name: fullName || undefined, firstName: subscriber.firstName };
      }
    }
  } catch {
    // Ignore errors - will fall back to email-based defaults
  }
  return {};
}

export function renderTemplate(
  template: IEmailTemplateDocument,
  variables: Record<string, string>,
  trackingToken: string
): { subject: string; html: string } {
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL);

  // Function replacers, not string replacements: a string replacement expands `$&`, `$1`,
  // etc. in the value, so a substitution value containing those splices raw template text
  // (and, in HTML, past escapeHtml). A replacer function receives the value verbatim.

  // 1. Substitute variables in subject (plain text, no HTML escaping needed)
  let subject = template.subject;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    subject = subject.replace(regex, () => value);
  }

  // 2. Substitute variables in HTML (escape values to prevent XSS)
  let html = template.htmlContent;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    const escaped = escapeHtml(value);
    html = html.replace(regex, () => escaped);
  }

  // 3. Inject tracking pixel (1x1 transparent GIF) before </body>
  const trackingPixel = `<img src="${baseUrl}/api/email/track/open/${trackingToken}" width="1" height="1" style="display:none;" alt="" />`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', () => `${trackingPixel}</body>`);
  } else {
    html = html + trackingPixel;
  }

  // 4. Wrap links for click tracking
  html = wrapLinksForTracking(html, trackingToken, baseUrl);

  // 5. Inject unsubscribe link variable
  // Fragment, not query: the token stays out of the unsubscribe URL sent to a server (app/utils/emailLinkToken.ts).
  const unsubscribeUrl = `${baseUrl}/email/unsubscribe#token=${trackingToken}`;
  html = html.replace(/{{unsubscribeUrl}}/g, () => unsubscribeUrl);
  subject = subject.replace(/{{unsubscribeUrl}}/g, () => unsubscribeUrl);

  return { subject, html };
}

function wrapLinksForTracking(html: string, token: string, baseUrl: string): string {
  // Match href with double quotes, single quotes, or no quotes
  // Handles: href="url", href='url', href=url
  return html.replace(
    /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const url = doubleQuoted || singleQuoted || unquoted;

      // Only wrap http/https URLs
      if (!url || !url.match(/^https?:\/\//i)) {
        return match;
      }

      // Don't wrap tracking URLs or unsubscribe URLs
      if (url.includes('/api/email/track/') || url.includes('/email/unsubscribe')) {
        return match;
      }

      const encodedUrl = encodeURIComponent(url);
      const trackingUrl = `${baseUrl}/api/email/track/click/${token}?url=${encodedUrl}`;

      // Preserve the original quote style
      if (doubleQuoted) {
        return `href="${trackingUrl}"`;
      } else if (singleQuoted) {
        return `href='${trackingUrl}'`;
      } else {
        return `href="${trackingUrl}"`; // Use double quotes for unquoted
      }
    }
  );
}
