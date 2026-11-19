import { Logger } from '@bike4mind/observability';
import { EmailEvents } from '../eventBus';
import type { MailSendResult } from './transport';
import type { SendEmailOptions } from './index';

export interface QueuedMail {
  subject: string;
  html: string;
  text?: string;
}

/** `queued` means the event bus accepted the mail; the email-send worker logs the delivery itself. */
export type QueuedMailResult = MailSendResult | { queued: true } | false;

/**
 * The mailer every process other than the email-send worker sends through. It has the shape of
 * MailService.sendEmail, so it drops into the `mailer` port the service-layer notifiers take: it
 * resolves false instead of throwing, and the options mean what they mean there.
 *
 * On a hosted stage the mail is published as an email.send event and the worker
 * (apps/workers/src/events/sendEmail.ts) is the one process that holds the transport. Self-host
 * has no event bus, so the mail goes to the SMTP mailer in this process and the result is the
 * delivery result. packages/scripts/src/checkMailSendSites.test.ts keeps direct sends from
 * coming back.
 */
export const queuedMailer = {
  async sendEmail(to: string | string[], mail: QueuedMail, options: SendEmailOptions = {}): Promise<QueuedMailResult> {
    if (process.env.B4M_SELF_HOST === 'true') {
      const { default: mailer } = await import('./index');
      return mailer.sendEmail(to, mail, options);
    }

    const recipient = Array.isArray(to) ? to.join(', ') : to;
    const { mirror, logRecipient, category } = options;
    try {
      const result = await EmailEvents.Send.publish({
        to: recipient,
        subject: mail.subject,
        body: mail.html,
        ...(mail.text !== undefined && { text: mail.text }),
        ...(category && { category }),
        ...(mirror !== undefined && { mirror }),
        ...(logRecipient !== undefined && { logRecipient }),
      });
      // PutEvents reports a rejected entry in its response instead of throwing.
      const rejected = result?.Entries?.find(entry => entry.ErrorCode);
      if (rejected) throw new Error(`${rejected.ErrorCode}: ${rejected.ErrorMessage ?? 'entry rejected'}`);
      return { queued: true };
    } catch (e: unknown) {
      const loggedRecipient = logRecipient === false ? '[redacted]' : recipient;
      Logger.error(
        `Email could not be queued for ${loggedRecipient} (subject: ${mail.subject}). ` +
          `Error: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
  },
};
