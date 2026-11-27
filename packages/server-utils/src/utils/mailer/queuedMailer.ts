import { Logger } from '@bike4mind/observability';
import { EmailEvents, type EmailDeliveryRef, type EmailSendDetail } from '../eventBus';
import { putMailBody } from './mailBodyStore';
import type { MailSendResult } from './transport';
import type { SendEmailOptions } from './index';

// EventBridge rejects an entry over 256 KB, and the serialized properties understate the full entry,
// so mail over this leaves the body in the mail body store (./mailBodyStore.ts) and sends a reference.
export const MAX_INLINE_MAIL_BYTES = 200 * 1024;
// Well under the SES v2 40 MB message limit and what common SMTP relays accept.
export const MAX_OFFLOADED_MAIL_BYTES = 10 * 1024 * 1024;

export interface QueuedMail {
  subject: string;
  html: string;
  text?: string;
}

export type QueuedMailOptions = SendEmailOptions & {
  /** Carried on the event so the worker can record the outcome; self-host callers record it themselves. */
  ref?: EmailDeliveryRef;
};

/**
 * `queued` means the event bus accepted the mail, not that it was delivered: the email-send worker
 * sends it, and a failed send is retried by EventBridge and then dead-lettered.
 */
export type QueuedMailResult = MailSendResult | { queued: true } | false;

async function withinEventLimit(properties: EmailSendDetail, mail: QueuedMail): Promise<EmailSendDetail> {
  if (Buffer.byteLength(JSON.stringify(properties)) <= MAX_INLINE_MAIL_BYTES) return properties;
  const bodySize = Buffer.byteLength(mail.html) + Buffer.byteLength(mail.text ?? '');
  if (bodySize > MAX_OFFLOADED_MAIL_BYTES) {
    throw new Error(`mail body is ${bodySize} bytes, over the ${MAX_OFFLOADED_MAIL_BYTES}-byte message limit`);
  }
  const key = await putMailBody(mail.text === undefined ? { html: mail.html } : { html: mail.html, text: mail.text });
  const { body: _body, text: _text, ...rest } = properties;
  return { ...rest, bodyRef: { key } };
}

/**
 * The mailer every process other than the email-send worker sends through. It has the shape of
 * MailService.sendEmail, so it drops into the `mailer` port the service-layer notifiers take: it
 * resolves false instead of throwing, and the options mean what they mean there.
 *
 * On a hosted stage the mail is published as an email.send event and the worker
 * (apps/workers/src/events/sendEmail.ts) is the one process that holds the transport. Self-host
 * has no event bus, so the mail goes to the SMTP mailer in this process and the result is the
 * delivery result. packages/scripts/src/checkMailSendSites.repo.test.ts keeps direct sends from
 * coming back.
 */
export const queuedMailer = {
  async sendEmail(to: string | string[], mail: QueuedMail, options: QueuedMailOptions = {}): Promise<QueuedMailResult> {
    const { ref, ...mailOptions } = options;
    if (process.env.B4M_SELF_HOST === 'true') {
      const { default: mailer } = await import('./index');
      return mailer.sendEmail(to, mail, mailOptions);
    }

    const recipient = Array.isArray(to) ? to.join(', ') : to;
    const { mirror, logRecipient, category } = mailOptions;
    const properties = {
      to: recipient,
      subject: mail.subject,
      body: mail.html,
      ...(mail.text !== undefined && { text: mail.text }),
      ...(category && { category }),
      ...(mirror !== undefined && { mirror }),
      ...(logRecipient !== undefined && { logRecipient }),
      ...(ref && { ref }),
    };
    try {
      const result = await EmailEvents.Send.publish(await withinEventLimit(properties, mail));
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
