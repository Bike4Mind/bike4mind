import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type Mail from 'nodemailer/lib/mailer';
import type { MailSendContext, MailSendResult, MailTransport } from './transport';

export const SMTP_DNS_TIMEOUT_MS = 5_000;
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
/** Inactivity, not total: resets on every SMTP exchange, so a slow-but-live server still completes. */
export const SMTP_SOCKET_TIMEOUT_MS = 15_000;

export const SES_CONFIGURATION_SET_HEADER = 'X-SES-CONFIGURATION-SET';

export interface SmtpTransportOptions {
  host: string;
  port: string;
  username: string;
  password: string;
  /** SES configuration set for `otc` mail, applied as a header the SES SMTP endpoint honours. */
  otcConfigurationSet?: string;
}

export class SmtpTransport implements MailTransport {
  readonly kind = 'smtp' as const;
  readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(private readonly options: SmtpTransportOptions) {
    // Implicit TLS on 465; mandatory STARTTLS on the 587 submission port so a
    // MITM cannot strip the upgrade. Other ports (e.g. a local Mailpit on
    // 1025) negotiate STARTTLS opportunistically or stay plain.
    const port = parseInt(options.port);
    this.transporter = nodemailer.createTransport({
      port,
      host: options.host,
      auth: {
        user: options.username,
        pass: options.password,
      },
      secure: port === 465,
      requireTLS: port === 587,
      // nodemailer's defaults (2 min connect, 30s greeting, 10 min socket idle) all outlive the 60s
      // web Lambda (infra/web.ts), and every route awaits sendEmail inline, so a stalled SMTP host
      // would 504 a request whose work had already committed. Keep the whole send well under that.
      dnsTimeout: SMTP_DNS_TIMEOUT_MS,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(mail: Mail.Options, context: MailSendContext = {}): Promise<MailSendResult> {
    // Only the OTC set travels as a header. The relay may sit in an account where the stage's
    // default set does not exist, and SES rejects a message naming an unknown set outright.
    const otcSet = context.category === 'otc' ? this.options.otcConfigurationSet : undefined;
    const message = otcSet
      ? { ...mail, headers: withHeader(mail.headers, SES_CONFIGURATION_SET_HEADER, otcSet) }
      : mail;
    const result = await this.transporter.sendMail(message);
    return { messageId: result.messageId };
  }

  describe(): string {
    return `SMTP host=${this.options.host}, port=${this.options.port}`;
  }
}

function withHeader(headers: Mail.Headers | undefined, key: string, value: string): Mail.Headers {
  if (Array.isArray(headers)) return [...headers, { key, value }];
  return { ...headers, [key]: value };
}
