import { withEventContext } from '@workers/utils/eventContext';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import mailer from '@bike4mind/server-utils/utils/mailer/index';
import { findMailSinkDomain, parseMailSinkDomains } from '@bike4mind/server-utils/utils/mailer/sinkDomains';

export const handler = withEventContext(async (event, logger) => {
  const { to, subject, body, attachments, category } = EmailEvents.Send.schema.parse(event.properties);

  logger.updateMetadata({
    to,
    subject,
    attachmentCount: attachments?.length || 0,
  });

  const sinkDomain = findMailSinkDomain(to, parseMailSinkDomains(process.env.MAIL_SINK_DOMAINS));
  if (sinkDomain) {
    logger.info('Email skipped: recipient is on a sink domain', { to, subject, sinkDomain });
    return;
  }

  const emailData: {
    subject: string;
    html: string;
    attachments?: {
      filename: string;
      content: Buffer;
      contentType: string;
    }[];
  } = {
    subject,
    html: body,
  };

  // If attachments are provided, convert base64 strings back to buffers
  if (attachments && attachments.length > 0) {
    emailData.attachments = attachments.map(att => ({
      filename: att.filename,
      content: Buffer.from(att.content, 'base64'),
      contentType: att.contentType,
    }));
  }

  // The transport picks the SES configuration set for the category (packages/server-utils/src/utils/mailer).
  const result = await mailer.sendEmail(to, emailData, { category });

  if (result === false) {
    logger.error('Email delivery failed - check MailService logs for details', { to, subject });
  } else {
    logger.info('Email delivered successfully', { to, subject, messageId: result.messageId });
  }
});
