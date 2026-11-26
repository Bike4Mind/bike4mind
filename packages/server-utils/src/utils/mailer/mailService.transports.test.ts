/**
 * The MailService contract run against both transports: whatever the backend, callers get the same
 * result shape, the same failure handling, the same Slack mirror and the same log redaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

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

vi.mock('../../integrations/slack/slack', () => ({
  postEmailMirrorToSlack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  isPlaceholderValue: (value: string | undefined | null) => {
    if (!value) return true;
    const normalized = value.trim().toLowerCase();
    return normalized === 'placeholder' || normalized === 'not_configured' || normalized === 'not-configured';
  },
}));

const configValues = vi.hoisted(() => ({
  MAIL_HOST: 'smtp.example.com',
  MAIL_PORT: '465',
  MAIL_USERNAME: 'user@example.com',
  MAIL_PASSWORD: 'secret',
  MAIL_FROM: 'noreply@example.com',
  SUPPORT_EMAIL: 'support@example.com',
}));

vi.mock('../config', () => ({ Config: configValues }));

const findSetting = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { findOne: findSetting } }));

const sesMock = mockClient(SESv2Client);

interface TransportCase {
  kind: 'smtp' | 'ses';
  make: () => Promise<import('./transport').MailTransport>;
  resolveSend: (messageId: string) => void;
  rejectSend: (error: Error) => void;
  sentRecipients: () => string[];
  sentFrom: () => string[];
}

const cases: TransportCase[] = [
  {
    kind: 'smtp',
    make: async () => {
      const { SmtpTransport } = await import('./smtpTransport');
      return new SmtpTransport({
        host: 'smtp.example.com',
        port: '465',
        username: 'u',
        password: 'p',
        otcConfigurationSet: 'otc-set',
      });
    },
    resolveSend: messageId => mockSendMail.mockResolvedValue({ messageId }),
    rejectSend: error => mockSendMail.mockRejectedValue(error),
    sentRecipients: () => mockSendMail.mock.calls.map(([mail]) => mail.to),
    sentFrom: () => mockSendMail.mock.calls.map(([mail]) => mail.from),
  },
  {
    kind: 'ses',
    make: async () => {
      const { SesTransport } = await import('./sesTransport');
      return new SesTransport({
        client: new SESv2Client({}),
        configurationSet: 'stage-set',
        otcConfigurationSet: 'otc-set',
      });
    },
    resolveSend: messageId => sesMock.on(SendEmailCommand).resolves({ MessageId: messageId }),
    rejectSend: error => sesMock.on(SendEmailCommand).rejects(error),
    sentRecipients: () =>
      sesMock
        .commandCalls(SendEmailCommand)
        .map(call => (call.args[0].input.Destination?.ToAddresses ?? []).join(', ')),
    sentFrom: () => sesMock.commandCalls(SendEmailCommand).map(call => call.args[0].input.FromEmailAddress ?? ''),
  },
];

describe.each(cases)('MailService over $kind', ({ kind, make, resolveSend, rejectSend, sentRecipients, sentFrom }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSetting.mockResolvedValue(null);
    sesMock.reset();
    mockVerify.mockResolvedValue(true);
    configValues.MAIL_HOST = 'smtp.example.com';
    configValues.MAIL_PASSWORD = 'secret';
    configValues.MAIL_FROM = 'noreply@example.com';
  });

  async function createMailService() {
    const { MailService } = await import('./index');
    return new MailService(await make());
  }

  it('reports its transport kind', async () => {
    const mailer = await createMailService();
    expect(mailer.transport.kind).toBe(kind);
    expect(mailer.getConfigStatus().transport).toBe(kind);
  });

  it('returns the backend message id and uses the configured sender', async () => {
    resolveSend('<msg-1>');
    const mailer = await createMailService();

    const result = await mailer.sendEmail('user@test.com', { subject: 'Welcome', html: '<h1>Hello</h1>' });

    expect(result).toEqual({ messageId: '<msg-1>' });
    expect(sentRecipients()).toEqual(['user@test.com']);
  });

  it('sends from the mailFrom admin setting when it holds a valid sender', async () => {
    resolveSend('<msg-5>');
    findSetting.mockResolvedValue({ settingName: 'mailFrom', settingValue: 'Ops Team <ops@example.com>' });
    const mailer = await createMailService();

    await mailer.sendEmail('user@test.com', { subject: 'Welcome', html: '<p>Hi</p>' });
    await mailer.sendTestEmail('recipient@example.com');

    const expected = kind === 'ses' ? '"Ops Team" <ops@example.com>' : 'Ops Team <ops@example.com>';
    expect(sentFrom()).toEqual([expected, expected]);
  });

  it('sends from the MAIL_FROM secret when the setting is empty', async () => {
    resolveSend('<msg-6>');
    findSetting.mockResolvedValue({ settingName: 'mailFrom', settingValue: '' });
    const mailer = await createMailService();

    await mailer.sendEmail('user@test.com', { subject: 'Welcome', html: '<p>Hi</p>' });
    await mailer.sendTestEmail('recipient@example.com');

    expect(sentFrom()).toEqual(['noreply@example.com', 'noreply@example.com']);
  });

  it('joins array recipients', async () => {
    resolveSend('<msg-2>');
    const mailer = await createMailService();

    await mailer.sendEmail(['a@test.com', 'b@test.com'], { subject: 'Multi', text: 'hi' });

    expect(sentRecipients()).toEqual(['a@test.com, b@test.com']);
  });

  it('mirrors to the email-audit Slack channel by default and skips it when asked', async () => {
    resolveSend('<msg-3>');
    const { postEmailMirrorToSlack } = await import('../../integrations/slack/slack');
    const mailer = await createMailService();

    await mailer.sendEmail('user@test.com', { subject: 'Welcome', html: '<p>Hi</p>' });
    expect(postEmailMirrorToSlack).toHaveBeenCalledTimes(1);

    await mailer.sendEmail('user@test.com', { subject: 'Welcome', html: '<p>Hi</p>' }, { mirror: false });
    expect(postEmailMirrorToSlack).toHaveBeenCalledTimes(1);
  });

  it('returns false on a rejected send, logs the alarm phrase and keeps a redacted recipient out of the logs', async () => {
    rejectSend(Object.assign(new Error('Backend said no'), { name: 'MessageRejected' }));
    const { Logger } = await import('@bike4mind/observability');
    const mailer = await createMailService();

    const result = await mailer.sendEmail(
      'quiet@test.com',
      { subject: 'Alert' },
      { mirror: false, logRecipient: false }
    );

    expect(result).toBe(false);
    const errorCalls = vi.mocked(Logger.error).mock.calls;
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][0]).toContain('Email delivery failed to [redacted]');
    expect(errorCalls[0][0]).toContain('Backend said no');
    expect(JSON.stringify([vi.mocked(Logger.info).mock.calls, errorCalls])).not.toContain('quiet@test.com');
  });

  it('passes the category through so OTC mail reaches its own configuration set', async () => {
    resolveSend('<msg-4>');
    const mailer = await createMailService();

    await mailer.sendEmail('user@test.com', { subject: 'Code', html: '<p>123456</p>' }, { category: 'otc' });

    if (kind === 'smtp') {
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'X-SES-CONFIGURATION-SET': 'otc-set' } })
      );
    } else {
      expect(sesMock.commandCalls(SendEmailCommand)[0].args[0].input.ConfigurationSetName).toBe('otc-set');
    }
  });

  it('sends the health-check test email and reports the message id', async () => {
    resolveSend('<test-1>');
    const mailer = await createMailService();

    const result = await mailer.sendTestEmail('recipient@example.com');

    expect(result).toEqual({ success: true, messageId: '<test-1>' });
    expect(sentRecipients()).toEqual(['recipient@example.com']);
  });

  it('reports a failed test email without throwing', async () => {
    rejectSend(new Error('Backend down'));
    const mailer = await createMailService();

    const result = await mailer.sendTestEmail('recipient@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Backend down');
  });

  it('requires only the sender secret on SES, the whole SMTP set otherwise', async () => {
    configValues.MAIL_HOST = 'not-configured';
    configValues.MAIL_PASSWORD = 'not-configured';
    const mailer = await createMailService();

    const status = mailer.getConfigStatus();

    if (kind === 'ses') {
      expect(status.configured).toBe(true);
      expect(status.missingSecrets).toEqual([]);
      expect(status.secrets).toEqual({ MAIL_FROM: true });
    } else {
      expect(status.configured).toBe(false);
      expect(status.missingSecrets).toEqual(['MAIL_HOST', 'MAIL_PASSWORD']);
      expect(status.secrets.MAIL_HOST).toBe(false);
    }
  });

  it('is unconfigured without a sender on either transport', async () => {
    configValues.MAIL_FROM = 'not-configured';
    const mailer = await createMailService();

    const status = mailer.getConfigStatus();

    expect(status.configured).toBe(false);
    expect(status.missingSecrets).toContain('MAIL_FROM');
  });
});

describe('createMailTransport', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds the SES transport with both configuration sets from the environment', async () => {
    vi.stubEnv('SES_CONFIGURATION_SET', 'stage-set');
    vi.stubEnv('OTC_SES_CONFIGURATION_SET', 'otc-set');
    const { createMailTransport } = await import('./index');
    const { SesTransport } = await import('./sesTransport');

    const transport = createMailTransport('ses');

    expect(transport).toBeInstanceOf(SesTransport);
    expect((transport as InstanceType<typeof SesTransport>).configurationSetFor(undefined)).toBe('stage-set');
    expect((transport as InstanceType<typeof SesTransport>).configurationSetFor('otc')).toBe('otc-set');
  });

  it('treats an empty set variable as absent', async () => {
    vi.stubEnv('SES_CONFIGURATION_SET', '');
    vi.stubEnv('OTC_SES_CONFIGURATION_SET', '');
    const { createMailTransport } = await import('./index');
    const { SesTransport } = await import('./sesTransport');

    const transport = createMailTransport('ses');

    expect(transport).toBeInstanceOf(SesTransport);
    expect((transport as InstanceType<typeof SesTransport>).configurationSetFor('otc')).toBeUndefined();
  });

  it('builds the SMTP transport from the mail secrets by default', async () => {
    const nodemailer = await import('nodemailer');
    const { createMailTransport } = await import('./index');
    const { SmtpTransport } = await import('./smtpTransport');

    const transport = createMailTransport();

    expect(transport).toBeInstanceOf(SmtpTransport);
    expect(nodemailer.default.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 465,
        auth: { user: 'user@example.com', pass: 'secret' },
      })
    );
  });
});

describe('SMTP without auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    Object.assign(configValues, { MAIL_HOST: 'smtp.example.com', MAIL_FROM: 'noreply@example.com' });
  });

  afterEach(() => {
    Object.assign(configValues, { MAIL_USERNAME: 'user@example.com', MAIL_PASSWORD: 'secret' });
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset', ''],
    ['placeholders', 'not-configured'],
  ])('omits auth from a self-host transport when both credentials are %s', async (_label, value) => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    Object.assign(configValues, { MAIL_USERNAME: value, MAIL_PASSWORD: value });
    const nodemailer = await import('nodemailer');
    const { createMailTransport } = await import('./index');

    createMailTransport('smtp');

    expect(nodemailer.default.createTransport).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ auth: expect.anything() })
    );
  });

  it('keeps auth on a hosted stage even when both credentials are unset', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    Object.assign(configValues, { MAIL_USERNAME: '', MAIL_PASSWORD: '' });
    const nodemailer = await import('nodemailer');
    const { createMailTransport } = await import('./index');

    createMailTransport('smtp');

    expect(nodemailer.default.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { user: '', pass: '' } })
    );
  });

  it('still logs in with a half-set pair on self-host, so a server that requires auth rejects the send', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    Object.assign(configValues, { MAIL_USERNAME: 'user@example.com', MAIL_PASSWORD: '' });
    const nodemailer = await import('nodemailer');
    const { createMailTransport } = await import('./index');

    createMailTransport('smtp');

    expect(nodemailer.default.createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { user: 'user@example.com', pass: '' } })
    );
  });

  it('points a self-host deploy at its env file, not sst, when a setting is missing', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    Object.assign(configValues, { MAIL_USERNAME: 'user@example.com', MAIL_PASSWORD: '' });
    const { Logger } = await import('@bike4mind/observability');
    const { MailService } = await import('./index');

    new MailService();

    const message = vi.mocked(Logger.warn).mock.calls.at(-1)?.[0];
    expect(message).toContain('MAIL_PASSWORD');
    expect(message).toContain('.env.selfhost');
    expect(message).not.toContain('sst secret set');
  });

  it('keeps the sst hint off self-host', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    Object.assign(configValues, { MAIL_USERNAME: 'user@example.com', MAIL_PASSWORD: '' });
    const { Logger } = await import('@bike4mind/observability');
    const { MailService } = await import('./index');

    new MailService();

    const message = vi.mocked(Logger.warn).mock.calls.at(-1)?.[0];
    expect(message).toContain('sst secret set MAIL_PASSWORD');
    expect(message).not.toContain('.env.selfhost');
  });

  it('does not warn about a self-host relay without auth', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    Object.assign(configValues, { MAIL_USERNAME: '', MAIL_PASSWORD: '' });
    const { Logger } = await import('@bike4mind/observability');
    const { MailService } = await import('./index');

    new MailService();

    expect(Logger.warn).not.toHaveBeenCalled();
  });

  it('still warns about unset credentials on a hosted stage', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    Object.assign(configValues, { MAIL_USERNAME: '', MAIL_PASSWORD: '' });
    const { Logger } = await import('@bike4mind/observability');
    const { MailService } = await import('./index');

    new MailService();

    expect(vi.mocked(Logger.warn).mock.calls.at(-1)?.[0]).toContain('MAIL_USERNAME, MAIL_PASSWORD');
  });
});
