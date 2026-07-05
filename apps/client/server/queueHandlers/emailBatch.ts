import {
  emailJobRepository,
  emailSendAttemptRepository,
  emailTemplateRepository,
  userRepository,
  subscriberRepository,
} from '@bike4mind/database';
import {
  EmailJobStatus,
  EmailJobOverallStatus,
  EmailSendStatus,
  IEmailTemplateDocument,
  IEmailSendAttemptDocument,
  requireEnv,
} from '@bike4mind/common';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import mailer from '@server/utils/mailer';
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

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  // Process all SQS records in this invocation (supports batch processing)
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

      const pendingAttempts = attempts.filter(
        (a): a is IEmailSendAttemptDocument => a !== null && a.status === EmailSendStatus.PENDING
      );

      if (pendingAttempts.length === 0) {
        logger.info('No pending attempts in this batch, skipping');
        continue;
      }

      logger.info(`Processing ${pendingAttempts.length} pending emails`);

      let sentCount = 0;
      let failedCount = 0;

      for (let i = 0; i < pendingAttempts.length; i += PARALLEL_SEND_SIZE) {
        const chunk = pendingAttempts.slice(i, i + PARALLEL_SEND_SIZE);

        const results = await Promise.allSettled(chunk.map(attempt => processAttempt(attempt, job, template, logger)));

        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value.success) {
              sentCount++;
            } else {
              failedCount++;
            }
          } else {
            failedCount++;
          }
        }
      }

      if (sentCount > 0) {
        await emailJobRepository.incrementCountsBy(jobId, 'sentCount', sentCount);
      }
      if (failedCount > 0) {
        await emailJobRepository.incrementCountsBy(jobId, 'failedCount', failedCount);
      }

      logger.info(`Batch ${(batchIndex ?? 0) + 1} complete: ${sentCount} sent, ${failedCount} failed`);

      await checkJobCompletion(jobId, logger);
    } catch (error) {
      logger.error('Failed to process batch record', error);
      // Continue processing other records even if one fails
    }
  }
});

async function processAttempt(
  attempt: IEmailSendAttemptDocument,
  job: { variables?: Record<string, string> },
  template: IEmailTemplateDocument,
  logger: { error: (msg: string) => void; info: (msg: string) => void }
): Promise<{ success: boolean }> {
  await emailSendAttemptRepository.updateStatus(attempt.id, EmailSendStatus.PROCESSING);

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

  let lastError: string = '';
  const startRetryCount = attempt.retryCount || 0;

  for (let retryAttempt = 0; retryAttempt < MAX_RETRY_ATTEMPTS; retryAttempt++) {
    try {
      const result = await mailer.sendEmail(attempt.recipientEmail, {
        subject: finalSubject,
        html: rendered.html,
      });

      if (result) {
        await emailSendAttemptRepository.updateStatus(attempt.id, EmailSendStatus.SENT, {
          sentAt: new Date(),
          renderedSubject: finalSubject,
          renderedHtml: rendered.html,
          retryCount: startRetryCount + retryAttempt,
        });
        if (retryAttempt > 0) {
          logger.info(`Email to ${attempt.recipientEmail} succeeded after ${retryAttempt} retries`);
        }
        return { success: true };
      } else {
        throw new Error('Mailer returned false');
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';

      if (retryAttempt < MAX_RETRY_ATTEMPTS - 1) {
        logger.info(`Retry ${retryAttempt + 1}/${MAX_RETRY_ATTEMPTS} for ${attempt.recipientEmail}: ${lastError}`);
        await sleep(RETRY_DELAY_MS * (retryAttempt + 1)); // linear backoff
      }
    }
  }

  logger.error(`Failed to send to ${attempt.recipientEmail} after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError}`);

  await emailSendAttemptRepository.updateStatus(attempt.id, EmailSendStatus.FAILED, {
    errorMessage: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError}`,
    retryCount: startRetryCount + MAX_RETRY_ATTEMPTS,
  });
  return { success: false };
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

/**
 * HTML-escape a string to prevent XSS when injecting into templates.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(
  template: IEmailTemplateDocument,
  variables: Record<string, string>,
  trackingToken: string
): { subject: string; html: string } {
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL);

  // 1. Substitute variables in subject (plain text, no HTML escaping needed)
  let subject = template.subject;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    subject = subject.replace(regex, value);
  }

  // 2. Substitute variables in HTML (escape values to prevent XSS)
  let html = template.htmlContent;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, escapeHtml(value));
  }

  // 3. Inject tracking pixel (1x1 transparent GIF) before </body>
  const trackingPixel = `<img src="${baseUrl}/api/email/track/open/${trackingToken}" width="1" height="1" style="display:none;" alt="" />`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', `${trackingPixel}</body>`);
  } else {
    html = html + trackingPixel;
  }

  // 4. Wrap links for click tracking
  html = wrapLinksForTracking(html, trackingToken, baseUrl);

  // 5. Inject unsubscribe link variable
  const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${trackingToken}`;
  html = html.replace(/{{unsubscribeUrl}}/g, unsubscribeUrl);
  subject = subject.replace(/{{unsubscribeUrl}}/g, unsubscribeUrl);

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

async function checkJobCompletion(jobId: string, logger: { info: (msg: string) => void }): Promise<void> {
  const job = await emailJobRepository.findById(jobId);
  if (!job) return;

  // Count pending and processing attempts (not yet finished)
  const pendingCount = await emailSendAttemptRepository.count({
    jobId,
    status: { $in: [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING] },
  });

  if (pendingCount === 0) {
    const sentCount = await emailSendAttemptRepository.count({
      jobId,
      status: EmailSendStatus.SENT,
    });
    const failedCount = await emailSendAttemptRepository.count({
      jobId,
      status: EmailSendStatus.FAILED,
    });
    const cancelledCount = await emailSendAttemptRepository.count({
      jobId,
      status: EmailSendStatus.CANCELLED,
    });

    let overallStatus: EmailJobOverallStatus;
    if (failedCount === 0 && cancelledCount === 0) {
      overallStatus = EmailJobOverallStatus.COMPLETE;
    } else if (sentCount === 0) {
      overallStatus = EmailJobOverallStatus.FAILED;
    } else {
      overallStatus = EmailJobOverallStatus.PARTIAL;
    }

    await emailJobRepository.update({
      id: jobId,
      status: EmailJobStatus.COMPLETED,
      overallStatus,
      completedAt: new Date(),
      cancelledCount,
    });
    logger.info(`Job ${jobId} completed with overallStatus: ${overallStatus}`);
  }
}
