import type Mail from 'nodemailer/lib/mailer';

export type MailTransportKind = 'smtp' | 'ses';

/** Mail categories a transport may route differently; matches EmailEvents.Send in ../eventBus. */
export type MailCategory = 'otc';

export interface MailSendContext {
  category?: MailCategory;
}

export interface MailSendResult {
  messageId: string;
}

export interface MailTransport {
  readonly kind: MailTransportKind;
  /** Resolves when the backend is reachable, rejects with the backend's error otherwise. */
  verify(): Promise<void>;
  send(mail: Mail.Options, context?: MailSendContext): Promise<MailSendResult>;
  /** One line naming the backend for delivery logs. Never includes credentials. */
  describe(): string;
}

/** The two process.env entries that pick the transport; typed loosely so process.env itself fits. */
export type MailTransportEnv = Record<string, string | undefined>;

/**
 * Self-host installs bring their own SMTP relay and never see SES. Hosted stages stay on SMTP until
 * MAIL_TRANSPORT says `ses`, so the flag is the only cutover step and flipping it back is the rollback.
 */
export function resolveMailTransportKind(env: MailTransportEnv = process.env): MailTransportKind {
  if (env.B4M_SELF_HOST === 'true') return 'smtp';
  return env.MAIL_TRANSPORT?.trim().toLowerCase() === 'ses' ? 'ses' : 'smtp';
}
