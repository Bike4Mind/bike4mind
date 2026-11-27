import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  sendTestEmail: vi.fn(),
  getMailBody: vi.fn(),
  recordOutcome: vi.fn(),
  connectDB: vi.fn(),
  logger: { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
// Adapts an EventBridge-shaped event into the (event, logger) call the wrapped callback receives.
vi.mock('@workers/utils/eventContext', () => ({
  withEventContext:
    (fn: (event: unknown, logger: unknown) => unknown) => (event: { 'detail-type': string; detail: unknown }) =>
      fn({ event: event['detail-type'], properties: event.detail }, mocks.logger),
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  EmailEvents: { Send: { schema: { parse: (value: unknown) => value } } },
}));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({
  default: { sendEmail: mocks.send, sendTestEmail: mocks.sendTestEmail, transport: { kind: 'ses' } },
}));
vi.mock('@bike4mind/database', () => ({ connectDB: mocks.connectDB }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://db.example/%STAGE%', STAGE: 'qa' },
}));
vi.mock('@bike4mind/server-utils/utils/mailer/mailBodyStore', () => ({ getMailBody: mocks.getMailBody }));
vi.mock('@bike4mind/server-utils/utils/mailer/deliveryOutcome', () => ({
  recordEmailDeliveryOutcome: mocks.recordOutcome,
}));
import { handler, MailBodyMissingError } from './sendEmail';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue({ messageId: 'synthetic-id' });
  mocks.sendTestEmail.mockResolvedValue({ success: true, messageId: 'test-id' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Attachment = { filename: string; content: string; contentType: string };
type Detail = Record<string, unknown>;

const deliver = (detail: Detail) => handler({ 'detail-type': 'email.send', detail } as never);

async function send(category?: 'otc', attachments?: Attachment[], to = 'test@example.org') {
  await deliver({ to, subject: 'Test', body: 'Body', category, attachments });
}

const everyLoggedValue = () =>
  JSON.stringify([mocks.logger.updateMetadata.mock.calls, mocks.logger.info.mock.calls, mocks.logger.error.mock.calls]);

it('passes the category through so the transport can pick the configuration set', async () => {
  await send('otc');
  expect(mocks.send).toHaveBeenCalledWith('test@example.org', { subject: 'Test', html: 'Body' }, { category: 'otc' });
  mocks.send.mockClear();
  await send();
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    { subject: 'Test', html: 'Body' },
    { category: undefined }
  );
});

it('decodes base64 attachments back into buffers', async () => {
  await send(undefined, [
    { filename: 'a.txt', content: Buffer.from('hello').toString('base64'), contentType: 'text/plain' },
  ]);
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    {
      subject: 'Test',
      html: 'Body',
      attachments: [{ filename: 'a.txt', content: Buffer.from('hello'), contentType: 'text/plain' }],
    },
    { category: undefined }
  );
});

it('logs a delivery failure and throws so the event is retried and dead-lettered', async () => {
  mocks.send.mockResolvedValue(false);
  await expect(send()).rejects.toThrow('Email delivery failed');
  expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Email delivery failed'), expect.anything());
});

it('skips delivery to a sink domain and logs the skip instead of a failure', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await send('otc', undefined, 'alice-e2e@test.com');
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.logger.error).not.toHaveBeenCalled();
  expect(mocks.logger.info).toHaveBeenCalledWith(
    expect.stringContaining('sink domain'),
    expect.objectContaining({ to: 'alice-e2e@test.com', sinkDomain: 'test.com' })
  );
});

it('still delivers to other domains when a sink list is set', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await send(undefined, undefined, 'alice@mail.test.com');
  expect(mocks.send).toHaveBeenCalledWith(
    'alice@mail.test.com',
    { subject: 'Test', html: 'Body' },
    { category: undefined }
  );
});

it('delivers everything when no sink list is set', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', '');
  await send(undefined, undefined, 'alice-e2e@test.com');
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('passes the plain-text body into the mail data', async () => {
  await deliver({ to: 'test@example.org', subject: 'Test', body: 'Body', text: 'Plain body' });
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    { subject: 'Test', html: 'Body', text: 'Plain body' },
    expect.anything()
  );
});

it('leaves the text key off the mail data when the event has none', async () => {
  await send();
  expect(mocks.send.mock.calls[0][1]).not.toHaveProperty('text');
});

it('passes mirror and logRecipient through as send options', async () => {
  await deliver({
    to: 'test@example.org',
    subject: 'Test',
    body: 'Body',
    category: 'otc',
    mirror: false,
    logRecipient: false,
  });
  expect(mocks.send).toHaveBeenCalledWith(
    'test@example.org',
    { subject: 'Test', html: 'Body' },
    { category: 'otc', mirror: false, logRecipient: false }
  );
});

it('names the recipient in its logs by default', async () => {
  await send();
  expect(mocks.logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ to: 'test@example.org' }));
  expect(mocks.logger.info).toHaveBeenCalledWith(
    'Email delivered successfully',
    expect.objectContaining({ to: 'test@example.org' })
  );
  mocks.send.mockResolvedValue(false);
  await expect(send()).rejects.toThrow('Email delivery failed');
  expect(mocks.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Email delivery failed'),
    expect.objectContaining({ to: 'test@example.org' })
  );
});

it('keeps the recipient out of every log line after a delivery when logRecipient is false', async () => {
  await deliver({ to: 'private@example.org', subject: 'Test', body: 'Body', logRecipient: false });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ to: '[redacted]' }));
  expect(mocks.logger.info).toHaveBeenCalledWith(
    'Email delivered successfully',
    expect.objectContaining({ to: '[redacted]' })
  );
  expect(everyLoggedValue()).not.toContain('private@example.org');
});

it('keeps the recipient out of every log line after a failed delivery when logRecipient is false', async () => {
  mocks.send.mockResolvedValue(false);
  await expect(
    deliver({ to: 'private@example.org', subject: 'Test', body: 'Body', logRecipient: false })
  ).rejects.toThrow('Email delivery failed');
  expect(mocks.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Email delivery failed'),
    expect.objectContaining({ to: '[redacted]' })
  );
  expect(everyLoggedValue()).not.toContain('private@example.org');
});

it('keeps the recipient out of every log line on a sink skip when logRecipient is false', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await deliver({ to: 'private@test.com', subject: 'Test', body: 'Body', logRecipient: false });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.logger.info).toHaveBeenCalledWith(
    expect.stringContaining('sink domain'),
    expect.objectContaining({ to: '[redacted]', sinkDomain: 'test.com' })
  );
  expect(everyLoggedValue()).not.toContain('private@test.com');
});

it('still names the recipient when logRecipient is true', async () => {
  await deliver({ to: 'test@example.org', subject: 'Test', body: 'Body', logRecipient: true });
  expect(mocks.logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ to: 'test@example.org' }));
});

it('answers a mail test request with the transport result and the transport name, without sending mail', async () => {
  const result = await handler({ mailTest: { to: 'qa@example.org' } });
  expect(result).toEqual({ success: true, messageId: 'test-id', transport: 'ses' });
  expect(mocks.sendTestEmail).toHaveBeenCalledWith('qa@example.org');
  expect(mocks.send).not.toHaveBeenCalled();
});

it('connects the database before a mail test, so the sender setting can be read', async () => {
  mocks.sendTestEmail.mockImplementation(async () => {
    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://db.example/qa');
    return { success: true, messageId: 'test-id' };
  });
  await handler({ mailTest: { to: 'qa@example.org' } });
  expect(mocks.sendTestEmail).toHaveBeenCalledOnce();
});

it('returns a failed test send as the result, with the transport name', async () => {
  mocks.sendTestEmail.mockResolvedValue({ success: false, error: 'relay refused the sender' });
  await expect(handler({ mailTest: { to: 'qa@example.org' } })).resolves.toEqual({
    success: false,
    error: 'relay refused the sender',
    transport: 'ses',
  });
});

it('refuses a mail test to a sink domain without sending it', async () => {
  vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
  await expect(handler({ mailTest: { to: 'qa@test.com' } })).resolves.toEqual({
    success: false,
    error: 'Mail to test.com is not delivered on this stage.',
    transport: 'ses',
  });
  expect(mocks.sendTestEmail).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.connectDB).not.toHaveBeenCalled();
});

it('does not let an email.send event ask for the test path', async () => {
  await deliver({ to: 'test@example.org', subject: 'Test', body: 'Body', mailTest: { to: 'other@example.org' } });
  expect(mocks.sendTestEmail).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0][0]).toBe('test@example.org');
});

describe('an event whose body was offloaded', () => {
  const key = 'queued-mail/0b6f2f3c-7d8e-4a51-9c3e-2f1d5e6a7b8c.json';
  const s3Error = (name: string, httpStatusCode: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
  const deliverRef = (to = 'test@example.org') => deliver({ to, subject: 'Test', bodyRef: { key } });

  it('reads the body and text back from the store and sends them', async () => {
    mocks.getMailBody.mockResolvedValue({ html: '<p>stored html</p>', text: 'stored text' });
    await deliverRef();
    expect(mocks.getMailBody).toHaveBeenCalledWith(key);
    expect(mocks.send).toHaveBeenCalledWith(
      'test@example.org',
      { subject: 'Test', html: '<p>stored html</p>', text: 'stored text' },
      { category: undefined }
    );
    expect(everyLoggedValue()).not.toContain('stored html');
  });

  it('leaves the text key off when the stored body has none', async () => {
    mocks.getMailBody.mockResolvedValue({ html: '<p>stored html</p>' });
    await deliverRef();
    expect(mocks.send.mock.calls[0][1]).toEqual({ subject: 'Test', html: '<p>stored html</p>' });
  });

  it.each([
    ['NoSuchKey', 404],
    ['AccessDenied', 403],
  ])('throws a clear error naming the expiry when S3 answers %s', async (name, status) => {
    mocks.getMailBody.mockRejectedValue(s3Error(name, status));
    const failure = deliverRef();
    await expect(failure).rejects.toBeInstanceOf(MailBodyMissingError);
    await expect(failure).rejects.toThrow(`mail body ${key} could not be read (S3 ${name}): it has expired`);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rethrows any other store failure as is, so EventBridge retries it', async () => {
    const throttled = s3Error('SlowDown', 503);
    mocks.getMailBody.mockRejectedValue(throttled);
    await expect(deliverRef()).rejects.toBe(throttled);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('never reads the store for a sink-domain recipient', async () => {
    vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
    await deliverRef('alice-e2e@test.com');
    expect(mocks.getMailBody).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('is not read for an inline body', async () => {
    await send();
    expect(mocks.getMailBody).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(
      'test@example.org',
      { subject: 'Test', html: 'Body' },
      { category: undefined }
    );
  });
});

describe('delivery outcome write-back', () => {
  const ref = { kind: 'emailAttempt', attemptId: 'attempt-1' };
  const sendWithRef = (to = 'test@example.org') => deliver({ to, subject: 'Test', body: 'Body', ref });

  it('records a delivered send against its ref', async () => {
    await sendWithRef();
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(ref, { ok: true, at: expect.any(Date) });
  });

  it('records a failed send and still throws so the event is retried', async () => {
    mocks.send.mockResolvedValue(false);
    await expect(sendWithRef()).rejects.toThrow('Email delivery failed');
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(ref, { ok: false, error: expect.any(String) });
  });

  it('records a sink-domain skip as failed without throwing or retrying', async () => {
    vi.stubEnv('MAIL_SINK_DOMAINS', 'test.com');
    await expect(sendWithRef('qa@test.com')).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(ref, {
      ok: false,
      error: 'Recipient domain is not delivered on this stage',
    });
  });

  it.each([
    [
      'an expired body',
      Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }),
    ],
    [
      'a throttled read',
      Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }),
    ],
  ])('records a failed send when the offloaded body cannot be read (%s) and still throws', async (_, s3Error) => {
    mocks.getMailBody.mockRejectedValue(s3Error);
    await expect(
      deliver({ to: 'test@example.org', subject: 'Test', bodyRef: { key: 'queued-mail/x.json' }, ref })
    ).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(ref, {
      ok: false,
      error: 'The queued message body could not be read',
    });
  });

  it('routes an incident alert ref to the write-back unchanged', async () => {
    const incidentRef = { kind: 'incidentAlert', incidentId: 'incident-1', alert: 'escalation' };
    await deliver({ to: 'test@example.org', subject: 'Test', body: 'Body', ref: incidentRef });
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(incidentRef, { ok: true, at: expect.any(Date) });
  });

  it('writes nothing back for mail published without a ref', async () => {
    await send();
    mocks.send.mockResolvedValue(false);
    await expect(send()).rejects.toThrow();
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });
});
