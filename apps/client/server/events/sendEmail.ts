import { withEventContext } from '@server/events/utils';
import { EmailEvents } from '@server/utils/eventBus';
import mailer from '@server/utils/mailer';

export const handler = withEventContext(async (event, logger) => {
  const { to, subject, body, attachments } = EmailEvents.Send.schema.parse(event.properties);

  logger.updateMetadata({
    to,
    subject,
    attachmentCount: attachments?.length || 0,
  });

  const emailData: any = {
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

  const result = await mailer.sendEmail(to, emailData);

  if (result === false) {
    logger.error('Email delivery failed - check MailService logs for details', { to, subject });
  } else {
    logger.info('Email delivered successfully', { to, subject, messageId: result.messageId });
  }
});
