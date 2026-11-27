import type { EventBridgeEvent } from 'aws-lambda';
import { connectDB } from '@bike4mind/database';
import { withEventContext } from '@workers/utils/eventContext';
import { Config } from '@bike4mind/server-utils/utils/config';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import mailer from '@bike4mind/server-utils/utils/mailer/index';
import { getMailBody, type StoredMailBody } from '@bike4mind/server-utils/utils/mailer/mailBodyStore';
import { recordEmailDeliveryOutcome } from '@bike4mind/server-utils/utils/mailer/deliveryOutcome';
import { findMailSinkDomain, parseMailSinkDomains } from '@bike4mind/server-utils/utils/mailer/sinkDomains';
import {
  isMailTestRequest,
  type LiveTestEmailResult,
  type MailTestRequest,
} from '@bike4mind/server-utils/utils/mailer/testEmail';

const sinkDomainFor = (to: string) => findMailSinkDomain(to, parseMailSinkDomains(process.env.MAIL_SINK_DOMAINS));

// S3 answers both a missing key and a missing grant with 403 here, so the message names both causes.
export class MailBodyMissingError extends Error {
  constructor(key: string, s3Error: string) {
    super(
      `mail body ${key} could not be read (S3 ${s3Error}): it has expired (the bucket lifecycle removes it 1-3 days ` +
        'after queueing, so a later DLQ redrive cannot be delivered), or MAIL_BODY_BUCKET names the wrong bucket, ' +
        'or this worker lacks GetObject on the queued-mail/ prefix'
    );
    this.name = 'MailBodyMissingError';
  }
}

async function readOffloadedBody(key: string): Promise<StoredMailBody> {
  try {
    return await getMailBody(key);
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
    // The worker holds GetObject without ListBucket (infra/mailBodyOffload.ts), so S3 answers a missing key with 403.
    if (name === 'NoSuchKey' || name === 'AccessDenied' || status === 404 || status === 403) {
      throw new MailBodyMissingError(key, name ?? String(status));
    }
    throw error;
  }
}

const deliver = withEventContext(async (event, logger) => {
  const { to, subject, body, bodyRef, text, attachments, category, mirror, logRecipient, ref } =
    EmailEvents.Send.schema.parse(event.properties);
  // Mail published with logRecipient: false keeps its address out of this worker's logs too.
  const loggedTo = logRecipient === false ? '[redacted]' : to;

  logger.updateMetadata({
    to: loggedTo,
    subject,
    attachmentCount: attachments?.length || 0,
  });

  const sinkDomain = sinkDomainFor(to);
  if (sinkDomain) {
    logger.info('Email skipped: recipient is on a sink domain', { to: loggedTo, subject, sinkDomain });
    if (ref)
      await recordEmailDeliveryOutcome(ref, { ok: false, error: 'Recipient domain is not delivered on this stage' });
    return;
  }
  let content: { html?: string; text?: string };
  try {
    content = bodyRef ? await readOffloadedBody(bodyRef.key) : { html: body, text };
  } catch (error) {
    // Record before rethrowing, or the attempt stays queued; a retry that later sends overwrites this.
    if (ref) await recordEmailDeliveryOutcome(ref, { ok: false, error: 'The queued message body could not be read' });
    throw error;
  }
  if (content.html === undefined) throw new Error('email.send event carries neither a body nor a bodyRef');

  const emailData: {
    subject: string;
    html: string;
    text?: string;
    attachments?: {
      filename: string;
      content: Buffer;
      contentType: string;
    }[];
  } = {
    subject,
    html: content.html,
  };
  if (content.text !== undefined) emailData.text = content.text;

  // If attachments are provided, convert base64 strings back to buffers
  if (attachments && attachments.length > 0) {
    emailData.attachments = attachments.map(att => ({
      filename: att.filename,
      content: Buffer.from(att.content, 'base64'),
      contentType: att.contentType,
    }));
  }

  // The transport picks the SES configuration set for the category (packages/server-utils/src/utils/mailer).
  const result = await mailer.sendEmail(to, emailData, { category, mirror, logRecipient });

  if (result === false) {
    logger.error('Email delivery failed - check MailService logs for details', { to: loggedTo, subject });
    if (ref)
      await recordEmailDeliveryOutcome(ref, { ok: false, error: 'The mail transport did not accept the message' });
    // Throwing fails the async invoke, so EventBridge retries it and a final failure lands in emailEventsDLQ.
    throw new Error('Email delivery failed');
  }
  logger.info('Email delivered successfully', { to: loggedTo, subject, messageId: result.messageId });
  if (ref) await recordEmailDeliveryOutcome(ref, { ok: true, at: new Date() });
});

/** The System Health test email: sent by the transport this worker delivers with, result returned to the caller. */
async function runMailTest({ mailTest: { to } }: MailTestRequest): Promise<LiveTestEmailResult> {
  const transport = mailer.transport.kind;
  const sinkDomain = sinkDomainFor(to);
  if (sinkDomain) {
    return { success: false, error: `Mail to ${sinkDomain} is not delivered on this stage.`, transport };
  }
  // A direct invoke skips withEventContext, and the sender is read from the mailFrom admin setting.
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
  return { ...(await mailer.sendTestEmail(to)), transport };
}

/**
 * Consumes email.send events. A direct invoke carrying a MailTestRequest (sendLiveTestEmail in
 * packages/server-utils/src/utils/mailer/testEmail.ts) runs the test send instead.
 */
export const handler = async (
  event: EventBridgeEvent<string, unknown> | MailTestRequest
): Promise<LiveTestEmailResult | void> => (isMailTestRequest(event) ? runMailTest(event) : deliver(event));
