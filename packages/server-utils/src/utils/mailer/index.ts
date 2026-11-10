import { isPlaceholderValue } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Config } from '../config';
import { postEmailMirrorToSlack } from '../../integrations/slack/slack';
import { extractBodyPreview, inferEmailType } from '../../integrations/slack/emailMirror';
import { SmtpTransport } from './smtpTransport';
import { SesTransport } from './sesTransport';
import {
  resolveMailTransportKind,
  type MailCategory,
  type MailSendResult,
  type MailTransport,
  type MailTransportKind,
} from './transport';

export {
  SMTP_DNS_TIMEOUT_MS,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
} from './smtpTransport';
export { resolveMailTransportKind } from './transport';
export type { MailCategory, MailSendContext, MailSendResult, MailTransport, MailTransportKind } from './transport';

export interface SendEmailOptions {
  /** Post the redacted copy to the email-audit Slack channel. Default true. */
  mirror?: boolean;
  /** Name the recipient in the delivery log lines. Default true. */
  logRecipient?: boolean;
  /** Lets the transport route the category through its own SES configuration set. */
  category?: MailCategory;
}

export interface EmailConfigStatus {
  configured: boolean;
  transport: MailTransportKind;
  missingSecrets: string[];
  secrets: {
    MAIL_HOST: boolean;
    MAIL_PORT: boolean;
    MAIL_USERNAME: boolean;
    MAIL_PASSWORD: boolean;
    MAIL_FROM: boolean;
  };
}

export interface TestEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Builds the transport the process should send through. Both configuration sets come from the
 * Lambda environment (infra/eventBus.ts); the SMTP settings are the MAIL_* secrets.
 */
export function createMailTransport(kind: MailTransportKind = resolveMailTransportKind()): MailTransport {
  const otcConfigurationSet = process.env.OTC_SES_CONFIGURATION_SET || undefined;
  if (kind === 'ses') {
    return new SesTransport({ configurationSet: process.env.SES_CONFIGURATION_SET || undefined, otcConfigurationSet });
  }
  return new SmtpTransport({
    host: Config.MAIL_HOST,
    port: Config.MAIL_PORT,
    username: Config.MAIL_USERNAME,
    password: Config.MAIL_PASSWORD,
    otcConfigurationSet,
  });
}

export class MailService {
  defaultFrom = Config.MAIL_FROM;
  // Account-tied support address from the SUPPORT_EMAIL secret; no brand fallback.
  // Undefined when unset/placeholder so consumers never receive the 'not-configured' default.
  supportEmail = isPlaceholderValue(Config.SUPPORT_EMAIL) ? undefined : Config.SUPPORT_EMAIL;

  readonly transport: MailTransport;

  constructor(transport: MailTransport = createMailTransport()) {
    this.transport = transport;
    this.validateConfig();
  }

  /** The secrets this transport needs; SES authenticates with the execution role, so only the sender. */
  private requiredSecrets(): Record<string, string> {
    const sender = { MAIL_FROM: Config.MAIL_FROM };
    if (this.transport.kind === 'ses') return sender;
    return {
      MAIL_HOST: Config.MAIL_HOST,
      MAIL_PORT: Config.MAIL_PORT,
      MAIL_USERNAME: Config.MAIL_USERNAME,
      MAIL_PASSWORD: Config.MAIL_PASSWORD,
      ...sender,
    };
  }

  private validateConfig() {
    const missing = Object.entries(this.requiredSecrets())
      .filter(([_, value]) => isPlaceholderValue(value))
      .map(([key]) => key);

    if (missing.length > 0) {
      Logger.warn(
        `Mail configuration incomplete (${this.transport.kind}) - emails will fail. ` +
          `Missing or placeholder values: ${missing.join(', ')}. ` +
          'Set MAIL_* secrets via: ./for-env {stage} npx sst secret set MAIL_HOST ...'
      );
    }
  }

  /**
   * Get the current email configuration status.
   * Used by admin system health panel to show config status without CloudWatch.
   */
  getConfigStatus(): EmailConfigStatus {
    const isConfigured = (value: string): boolean => !isPlaceholderValue(value);

    const missingSecrets = Object.entries(this.requiredSecrets())
      .filter(([_, value]) => !isConfigured(value))
      .map(([key]) => key);

    return {
      configured: missingSecrets.length === 0,
      transport: this.transport.kind,
      missingSecrets,
      secrets: {
        MAIL_HOST: isConfigured(Config.MAIL_HOST),
        MAIL_PORT: isConfigured(Config.MAIL_PORT),
        MAIL_USERNAME: isConfigured(Config.MAIL_USERNAME),
        MAIL_PASSWORD: isConfigured(Config.MAIL_PASSWORD),
        MAIL_FROM: isConfigured(Config.MAIL_FROM),
      },
    };
  }

  /**
   * Send a test email to verify the transport can deliver.
   * Used by admin system health panel.
   */
  async sendTestEmail(to: string): Promise<TestEmailResult> {
    try {
      await this.transport.verify();

      const result = await this.transport.send({
        from: this.defaultFrom,
        to,
        subject: 'System Health Test Email',
        text: `This is a test email from the System Health admin panel.\n\nIf you received this, your email configuration is working correctly.\n\nTimestamp: ${new Date().toISOString()}`,
        html: `
          <h2>System Health Test Email</h2>
          <p>This is a test email from the System Health admin panel.</p>
          <p>If you received this, your email configuration is working correctly.</p>
          <p><small>Timestamp: ${new Date().toISOString()}</small></p>
        `,
      });

      Logger.info(`Test email sent successfully to ${to} (messageId: ${result.messageId})`);

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (e: unknown) {
      const errorMessage = describeTransportError(e, this.transport.kind);

      Logger.error(`Test email failed to ${to}. Transport: ${this.transport.describe()}. Error: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * `mirror: false` skips the email-audit Slack copy and `logRecipient: false` keeps the address out
   * of the delivery logs, for mail whose recipients or existence should stay in the mailbox.
   */
  async sendEmail(
    to: string | string[],
    data: unknown,
    options: SendEmailOptions = {}
  ): Promise<MailSendResult | false> {
    const { mirror = true, logRecipient = true, category } = options;
    const recipient = to instanceof Array ? to.join(', ') : to;
    const loggedRecipient = logRecipient ? recipient : '[redacted]';
    const subject = (data as { subject?: string })?.subject || 'unknown';

    // try/catch here (not delegating the error) so the API call still succeeds even when mail fails
    try {
      const result = await this.transport.send(
        {
          from: this.defaultFrom,
          to: recipient,
          ...(typeof data === 'object' && data),
        },
        { category }
      );

      Logger.info(`Email sent successfully to ${loggedRecipient} (messageId: ${result.messageId})`);

      // Mirror a redacted copy to the email-audit Slack channel. Awaited (not
      // fire-and-forget) so the POST completes before a Lambda freezes the
      // process; postEmailMirrorToSlack swallows its own errors, so this can
      // neither throw nor change the email result. bodyPreview is redacted in
      // extractBodyPreview - raw tokens never reach Slack.
      if (mirror) {
        await postEmailMirrorToSlack({
          to: recipient,
          subject,
          emailType: inferEmailType(subject),
          bodyPreview: extractBodyPreview(data),
        });
      }

      return result;
      // eslint-disable-next-line
    } catch (e: any) {
      // "Email delivery failed" is the metric filter pattern in infra/mailAlarms.ts.
      Logger.error(
        `Email delivery failed to ${loggedRecipient} (subject: ${subject}). ` +
          `Transport: ${this.transport.describe()}. ` +
          `Error: ${e.message}`,
        e.code ? `SMTP code: ${e.code}` : e.name && e.name !== 'Error' ? `Error: ${e.name}` : '',
        e.command ? `SMTP command: ${e.command}` : '',
        e.stack ? `\nStack: ${e.stack}` : ''
      );
      return false;
    }
  }
}

function describeTransportError(e: unknown, kind: MailTransportKind): string {
  const error = e as Error & { code?: string; name?: string };
  if (error.code) return `${error.message} (SMTP code: ${error.code})`;
  if (kind === 'ses' && error.name && error.name !== 'Error') return `${error.message} (SES error: ${error.name})`;
  return error.message;
}

const mailer = new MailService();
export default mailer;
