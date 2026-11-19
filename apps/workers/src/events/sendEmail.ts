import type { EventBridgeEvent } from 'aws-lambda';
import { withEventContext } from '@workers/utils/eventContext';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import mailer from '@bike4mind/server-utils/utils/mailer/index';
import { findMailSinkDomain, parseMailSinkDomains } from '@bike4mind/server-utils/utils/mailer/sinkDomains';
import {
  isMailTestRequest,
  type LiveTestEmailResult,
  type MailTestRequest,
} from '@bike4mind/server-utils/utils/mailer/testEmail';

const sinkDomainFor = (to: string) => findMailSinkDomain(to, parseMailSinkDomains(process.env.MAIL_SINK_DOMAINS));

const deliver = withEventContext(async (event, logger) => {
  const { to, subject, body, text, attachments, category, mirror, logRecipient } = EmailEvents.Send.schema.parse(
    event.properties
  );
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
    return;
  }

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
    html: body,
  };
  if (text !== undefined) emailData.text = text;

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
  } else {
    logger.info('Email delivered successfully', { to: loggedTo, subject, messageId: result.messageId });
  }
});

/** The System Health test email: sent by the transport this worker delivers with, result returned to the caller. */
async function runMailTest({ mailTest: { to } }: MailTestRequest): Promise<LiveTestEmailResult> {
  const transport = mailer.transport.kind;
  const sinkDomain = sinkDomainFor(to);
  if (sinkDomain) {
    return { success: false, error: `Mail to ${sinkDomain} is not delivered on this stage.`, transport };
  }
  return { ...(await mailer.sendTestEmail(to)), transport };
}

/**
 * Consumes email.send events. A direct invoke carrying a MailTestRequest (sendLiveTestEmail in
 * packages/server-utils/src/utils/mailer/testEmail.ts) runs the test send instead.
 */
export const handler = async (
  event: EventBridgeEvent<string, unknown> | MailTestRequest
): Promise<LiveTestEmailResult | void> => (isMailTestRequest(event) ? runMailTest(event) : deliver(event));
