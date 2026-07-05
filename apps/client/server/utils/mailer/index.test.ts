import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerify = vi.fn();
const mockSendMail = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: mockVerify,
      sendMail: mockSendMail,
    })),
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the Slack poster module: it transitively imports @bike4mind/utils
// (-> fab-pipeline -> BedrockEmbeddingModel from @bike4mind/common), which the
// partial @bike4mind/common mock below doesn't provide. The mailer only calls
// postEmailMirrorToSlack, which swallows its own errors.
vi.mock('@server/integrations/slack/slack', () => ({
  postEmailMirrorToSlack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/common', () => ({
  isPlaceholderValue: (value: string | undefined | null) => {
    if (!value) return true;
    const normalized = value.trim().toLowerCase();
    return normalized === 'placeholder' || normalized === 'not_configured';
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    MAIL_HOST: 'smtp.example.com',
    MAIL_PORT: '465',
    MAIL_USERNAME: 'user@example.com',
    MAIL_PASSWORD: 'secret',
    MAIL_FROM: 'noreply@example.com',
    SUPPORT_EMAIL: 'support@example.com',
  },
}));

describe('MailService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Re-import for each test group to get a fresh MailService instance
  async function createMailService() {
    // Dynamic import so mocks are applied
    const { MailService } = await import('./index');
    return new MailService();
  }

  describe('constructor and config', () => {
    it('creates a nodemailer transport with configured values', async () => {
      const nodemailer = await import('nodemailer');
      await createMailService();

      expect(nodemailer.default.createTransport).toHaveBeenCalledWith({
        port: 465,
        host: 'smtp.example.com',
        auth: { user: 'user@example.com', pass: 'secret' },
        secure: true,
      });
    });
  });

  describe('getConfigStatus', () => {
    it('reports all secrets as configured when values are real', async () => {
      const mailer = await createMailService();
      const status = mailer.getConfigStatus();

      expect(status.configured).toBe(true);
      expect(status.missingSecrets).toEqual([]);
      expect(status.secrets).toEqual({
        MAIL_HOST: true,
        MAIL_PORT: true,
        MAIL_USERNAME: true,
        MAIL_PASSWORD: true,
        MAIL_FROM: true,
      });
    });
  });

  describe('sendTestEmail', () => {
    it('verifies SMTP connection then sends test email', async () => {
      mockVerify.mockResolvedValue(true);
      mockSendMail.mockResolvedValue({ messageId: '<test-123@example.com>' });

      const mailer = await createMailService();
      const result = await mailer.sendTestEmail('recipient@example.com');

      expect(mockVerify).toHaveBeenCalledOnce();
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@example.com',
          to: 'recipient@example.com',
          subject: 'System Health Test Email',
        })
      );
      expect(result).toEqual({
        success: true,
        messageId: '<test-123@example.com>',
      });
    });

    it('returns error result when SMTP verify fails', async () => {
      mockVerify.mockRejectedValue(new Error('SMTP connection refused'));

      const mailer = await createMailService();
      const result = await mailer.sendTestEmail('recipient@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP connection refused');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('includes SMTP code in error when available', async () => {
      const smtpError = Object.assign(new Error('Auth failed'), { code: 'EAUTH' });
      mockVerify.mockRejectedValue(smtpError);

      const mailer = await createMailService();
      const result = await mailer.sendTestEmail('recipient@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Auth failed (SMTP code: EAUTH)');
    });
  });

  describe('sendEmail', () => {
    it('sends email with provided data (nodemailer v8 compatibility)', async () => {
      mockSendMail.mockResolvedValue({ messageId: '<msg-456@example.com>' });

      const mailer = await createMailService();
      const result = await mailer.sendEmail('user@test.com', {
        subject: 'Welcome',
        html: '<h1>Hello</h1>',
        text: 'Hello',
      });

      expect(mockSendMail).toHaveBeenCalledWith({
        from: 'noreply@example.com',
        to: 'user@test.com',
        subject: 'Welcome',
        html: '<h1>Hello</h1>',
        text: 'Hello',
      });
      expect(result).toEqual({ messageId: '<msg-456@example.com>' });
    });

    it('joins array recipients into comma-separated string', async () => {
      mockSendMail.mockResolvedValue({ messageId: '<msg-789>' });

      const mailer = await createMailService();
      await mailer.sendEmail(['a@test.com', 'b@test.com'], { subject: 'Multi' });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'a@test.com, b@test.com',
        })
      );
    });

    it('returns false on send failure without throwing', async () => {
      mockSendMail.mockRejectedValue(new Error('Network timeout'));

      const mailer = await createMailService();
      const result = await mailer.sendEmail('user@test.com', { subject: 'Test' });

      expect(result).toBe(false);
    });

    it('handles SMTP error codes gracefully', async () => {
      const smtpError = Object.assign(new Error('Relay denied'), {
        code: '550',
        command: 'RCPT TO',
      });
      mockSendMail.mockRejectedValue(smtpError);

      const mailer = await createMailService();
      const result = await mailer.sendEmail('user@test.com', { subject: 'Test' });

      expect(result).toBe(false);
      const { Logger } = await import('@bike4mind/observability');
      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Relay denied'),
        expect.stringContaining('550'),
        expect.stringContaining('RCPT TO'),
        expect.any(String)
      );
    });
  });
});
