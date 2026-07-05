import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { isPlaceholderValue } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { postEmailMirrorToSlack } from '@server/integrations/slack/slack';
import { extractBodyPreview, inferEmailType } from '@server/integrations/slack/emailMirror';

export interface EmailConfigStatus {
  configured: boolean;
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

export class MailService {
  defaultFrom = Config.MAIL_FROM;
  // Account-tied support address from the SUPPORT_EMAIL secret; no brand fallback.
  // Undefined when unset/placeholder so consumers never receive the 'not-configured' default.
  supportEmail = isPlaceholderValue(Config.SUPPORT_EMAIL) ? undefined : Config.SUPPORT_EMAIL;

  transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor() {
    this.transporter = nodemailer.createTransport({
      port: parseInt(Config.MAIL_PORT),
      host: Config.MAIL_HOST,
      auth: {
        user: Config.MAIL_USERNAME,
        pass: Config.MAIL_PASSWORD,
      },
      secure: true,
    });

    this.validateConfig();
  }

  private validateConfig() {
    const requiredFields: Record<string, string> = {
      MAIL_HOST: Config.MAIL_HOST,
      MAIL_PORT: Config.MAIL_PORT,
      MAIL_USERNAME: Config.MAIL_USERNAME,
      MAIL_PASSWORD: Config.MAIL_PASSWORD,
      MAIL_FROM: Config.MAIL_FROM,
    };

    const missing = Object.entries(requiredFields)
      .filter(([_, value]) => isPlaceholderValue(value))
      .map(([key]) => key);

    if (missing.length > 0) {
      Logger.warn(
        'Mail configuration incomplete - emails will fail. ' +
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
    const requiredFields: Record<string, string> = {
      MAIL_HOST: Config.MAIL_HOST,
      MAIL_PORT: Config.MAIL_PORT,
      MAIL_USERNAME: Config.MAIL_USERNAME,
      MAIL_PASSWORD: Config.MAIL_PASSWORD,
      MAIL_FROM: Config.MAIL_FROM,
    };

    const isConfigured = (value: string): boolean => !isPlaceholderValue(value);

    const missingSecrets = Object.entries(requiredFields)
      .filter(([_, value]) => !isConfigured(value))
      .map(([key]) => key);

    return {
      configured: missingSecrets.length === 0,
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
   * Send a test email to verify SMTP connectivity.
   * Used by admin system health panel.
   */
  async sendTestEmail(to: string): Promise<TestEmailResult> {
    try {
      await this.transporter.verify();

      const result = await this.transporter.sendMail({
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
      const error = e as Error & { code?: string; command?: string };
      const errorMessage = `${error.message}${error.code ? ` (SMTP code: ${error.code})` : ''}`;

      Logger.error(
        `Test email failed to ${to}. ` +
          `SMTP config: host=${Config.MAIL_HOST}, port=${Config.MAIL_PORT}. ` +
          `Error: ${errorMessage}`
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async sendEmail(to: string | string[], data: unknown) {
    const recipient = to instanceof Array ? to.join(', ') : to;
    const subject = (data as { subject?: string })?.subject || 'unknown';

    // try/catch here (not delegating the error) so the API call still succeeds even when mail fails
    try {
      const result = await this.transporter.sendMail({
        from: this.defaultFrom,
        to: recipient,
        ...(typeof data === 'object' && data),
      });

      Logger.info(`Email sent successfully to ${recipient} (messageId: ${result.messageId})`);

      // Mirror a redacted copy to the email-audit Slack channel. Awaited (not
      // fire-and-forget) so the POST completes before a Lambda freezes the
      // process; postEmailMirrorToSlack swallows its own errors, so this can
      // neither throw nor change the email result. bodyPreview is redacted in
      // extractBodyPreview - raw tokens never reach Slack.
      await postEmailMirrorToSlack({
        to: recipient,
        subject,
        emailType: inferEmailType(subject),
        bodyPreview: extractBodyPreview(data),
      });

      return result;
      // eslint-disable-next-line
    } catch (e: any) {
      Logger.error(
        `Email delivery failed to ${recipient} (subject: ${subject}). ` +
          `SMTP config: host=${Config.MAIL_HOST}, port=${Config.MAIL_PORT}. ` +
          `Error: ${e.message}`,
        e.code ? `SMTP code: ${e.code}` : '',
        e.command ? `SMTP command: ${e.command}` : '',
        e.stack ? `\nStack: ${e.stack}` : ''
      );
      return false;
    }
  }
}

const mailer = new MailService();
export default mailer;
