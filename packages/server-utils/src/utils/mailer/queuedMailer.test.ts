import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  logError: vi.fn(),
  mailerSend: vi.fn(),
  indexLoaded: vi.fn(),
}));

vi.mock('../eventBus', () => ({ EmailEvents: { Send: { publish: mocks.publish } } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: mocks.logError } }));
vi.mock('./index', () => ({ default: { sendEmail: mocks.mailerSend } }));

// A fresh copy of the module whose lazy import of ./index is observable.
async function loadFreshQueuedMailer() {
  vi.resetModules();
  mocks.indexLoaded.mockClear();
  vi.doMock('./index', () => {
    mocks.indexLoaded();
    return { default: { sendEmail: mocks.mailerSend } };
  });
  return (await import('./queuedMailer')).queuedMailer;
}

import { mockClient } from 'aws-sdk-client-mock';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MAX_INLINE_MAIL_BYTES, MAX_OFFLOADED_MAIL_BYTES, queuedMailer } from './queuedMailer';

const s3 = mockClient(S3Client);

const mail = { subject: 'Hello', html: '<p>Body</p>' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('B4M_SELF_HOST', 'false');
  vi.stubEnv('MAIL_BODY_BUCKET', 'mail-bodies');
  s3.reset();
  s3.on(PutObjectCommand).resolves({});
  mocks.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('queuedMailer on a hosted stage', () => {
  it('publishes the mail as an email.send event and reports it queued', async () => {
    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toEqual({ queued: true });

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith({ to: 'a@example.org', subject: 'Hello', body: '<p>Body</p>' });
  });

  it('leaves every optional field off the event when it was not set', async () => {
    await queuedMailer.sendEmail('a@example.org', mail);

    expect(Object.keys(mocks.publish.mock.calls[0][0]).sort()).toEqual(['body', 'subject', 'to']);
  });

  it('carries the delivery ref on the event so the worker can record the outcome', async () => {
    const ref = { kind: 'emailAttempt' as const, attemptId: 'attempt-1' };
    await queuedMailer.sendEmail('a@example.org', mail, { ref, logRecipient: false });

    expect(mocks.publish).toHaveBeenCalledWith({
      to: 'a@example.org',
      subject: 'Hello',
      body: '<p>Body</p>',
      logRecipient: false,
      ref,
    });
  });

  it('puts text, category, mirror and logRecipient on the event when they are set', async () => {
    await queuedMailer.sendEmail(
      'a@example.org',
      { ...mail, text: 'Plain body' },
      { category: 'otc', mirror: false, logRecipient: false }
    );

    expect(mocks.publish).toHaveBeenCalledWith({
      to: 'a@example.org',
      subject: 'Hello',
      body: '<p>Body</p>',
      text: 'Plain body',
      category: 'otc',
      mirror: false,
      logRecipient: false,
    });
  });

  it('carries an explicit true for mirror and logRecipient rather than dropping it', async () => {
    await queuedMailer.sendEmail('a@example.org', mail, { mirror: true, logRecipient: true });

    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ mirror: true, logRecipient: true }));
  });

  it('joins an array of recipients with a comma and a space', async () => {
    await queuedMailer.sendEmail(['a@example.org', 'b@example.org'], mail);

    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.org, b@example.org' }));
  });

  it('accepts a response whose entries carry no error code', async () => {
    mocks.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }, { EventId: 'event-2' }] });

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toEqual({ queued: true });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('resolves false and logs the failure when publishing throws', async () => {
    mocks.publish.mockRejectedValue(new Error('bus unreachable'));

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toBe(false);

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const message = mocks.logError.mock.calls[0][0] as string;
    expect(message).toContain('a@example.org');
    expect(message).toContain('Hello');
    expect(message).toContain('bus unreachable');
  });

  it('describes a thrown non-Error value', async () => {
    mocks.publish.mockRejectedValue('plain string failure');

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toBe(false);

    expect(mocks.logError.mock.calls[0][0]).toContain('plain string failure');
  });

  it('publishes mail at the inline limit without storing the body', async () => {
    const html = 'x'.repeat(MAX_INLINE_MAIL_BYTES - 200);
    await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Big', html })).resolves.toEqual({ queued: true });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ body: html }));
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  describe('inline limit edge', () => {
    // Bytes of the serialized event properties around an empty body, so html fills the rest exactly.
    const envelope = Buffer.byteLength(JSON.stringify({ to: 'a@example.org', subject: 'Edge', body: '' }));

    it('keeps mail whose serialized properties are exactly the inline limit inline', async () => {
      const html = 'x'.repeat(MAX_INLINE_MAIL_BYTES - envelope);
      await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Edge', html })).resolves.toEqual({
        queued: true,
      });
      expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ body: html }));
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('offloads mail one byte over the inline limit', async () => {
      const html = 'x'.repeat(MAX_INLINE_MAIL_BYTES - envelope + 1);
      await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Edge', html })).resolves.toEqual({
        queued: true,
      });
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(mocks.publish).toHaveBeenCalledWith(expect.not.objectContaining({ body: expect.anything() }));
    });

    it('sets the inline limit at 200 KB', () => {
      expect(MAX_INLINE_MAIL_BYTES).toBe(200 * 1024);
    });

    it('measures UTF-8 bytes, not characters', async () => {
      // Two bytes per character: under the limit in characters, over it in bytes.
      const html = '\u00e9'.repeat(Math.ceil(MAX_INLINE_MAIL_BYTES / 2) + 1);
      expect(html.length).toBeLessThan(MAX_INLINE_MAIL_BYTES - envelope);
      await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Edge', html })).resolves.toEqual({
        queued: true,
      });
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
    });
  });

  it('stores an over-limit body under the prefix and publishes a reference to it', async () => {
    const html = 'x'.repeat(300 * 1024);
    await expect(
      queuedMailer.sendEmail('a@example.org', { subject: 'Big', html, text: 'plain' }, { mirror: false })
    ).resolves.toEqual({ queued: true });

    const [put] = s3.commandCalls(PutObjectCommand);
    const { Bucket, Key, Body, ContentType } = put.args[0].input;
    expect(Bucket).toBe('mail-bodies');
    expect(Key).toMatch(/^queued-mail\/[0-9a-f-]{36}\.json$/);
    expect(ContentType).toBe('application/json');
    expect(JSON.parse(Body as string)).toEqual({ html, text: 'plain' });
    expect(mocks.publish).toHaveBeenCalledWith({
      to: 'a@example.org',
      subject: 'Big',
      bodyRef: { key: Key },
      mirror: false,
    });
  });

  it('resolves false without storing or publishing a body over the message limit', async () => {
    const html = 'x'.repeat(MAX_OFFLOADED_MAIL_BYTES + 1);
    await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Huge', html })).resolves.toBe(false);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('over the 10485760-byte message limit'));
  });

  it('counts the text part toward the message limit', async () => {
    const html = 'x'.repeat(MAX_OFFLOADED_MAIL_BYTES - 10);
    const result = await queuedMailer.sendEmail('a@example.org', { subject: 'Huge', html, text: 'y'.repeat(11) });
    expect(result).toBe(false);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('mail body is 10485761 bytes'));
  });

  it('stores a body of html plus text exactly at the message limit', async () => {
    const html = 'x'.repeat(MAX_OFFLOADED_MAIL_BYTES - 10);
    const result = await queuedMailer.sendEmail('a@example.org', { subject: 'Huge', html, text: '\u00e9'.repeat(5) });
    expect(result).toEqual({ queued: true });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('resolves false without publishing when the body bucket is not configured', async () => {
    vi.stubEnv('MAIL_BODY_BUCKET', '');
    const html = 'x'.repeat(300 * 1024);
    await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Big', html })).resolves.toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('MAIL_BODY_BUCKET is not set'));
  });

  it('resolves false without publishing when storing the body fails, and keeps the body out of the log', async () => {
    s3.on(PutObjectCommand).rejects(new Error('AccessDenied'));
    const html = 'secret-'.repeat(50 * 1024);
    await expect(queuedMailer.sendEmail('a@example.org', { subject: 'Big', html })).resolves.toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
    expect(mocks.logError).not.toHaveBeenCalledWith(expect.stringContaining('secret-'));
  });

  it('resolves false when the bus response rejects an entry instead of throwing', async () => {
    mocks.publish.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }],
    });

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toBe(false);

    const message = mocks.logError.mock.calls[0][0] as string;
    expect(message).toContain('ThrottlingException');
    expect(message).toContain('slow down');
  });

  it('still resolves false for a rejected entry that has no message', async () => {
    mocks.publish.mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toBe(false);

    expect(mocks.logError.mock.calls[0][0]).toContain('InternalFailure');
  });

  it('names the recipient in the failure log by default', async () => {
    mocks.publish.mockRejectedValue(new Error('bus unreachable'));

    await queuedMailer.sendEmail('a@example.org', mail);

    expect(mocks.logError.mock.calls[0][0]).not.toContain('[redacted]');
  });

  it.each([
    ['a thrown error', () => mocks.publish.mockRejectedValue(new Error('bus unreachable'))],
    [
      'a rejected entry',
      () => mocks.publish.mockResolvedValue({ Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'x' }] }),
    ],
  ])('keeps the recipient out of the failure log after %s when logRecipient is false', async (_label, arrange) => {
    arrange();

    await queuedMailer.sendEmail(['a@example.org', 'b@example.org'], mail, { logRecipient: false });

    const message = mocks.logError.mock.calls[0][0] as string;
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('example.org');
  });

  it('never loads the SMTP mailer', async () => {
    const fresh = await loadFreshQueuedMailer();

    await fresh.sendEmail('a@example.org', mail);
    mocks.publish.mockRejectedValue(new Error('bus unreachable'));
    await fresh.sendEmail('a@example.org', mail);

    expect(mocks.indexLoaded).not.toHaveBeenCalled();
    expect(mocks.mailerSend).not.toHaveBeenCalled();
  });
});

describe('queuedMailer on self-host', () => {
  beforeEach(() => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    mocks.mailerSend.mockResolvedValue({ messageId: 'smtp-1' });
  });

  it('hands the mail to the mailer with the same three arguments and returns its result', async () => {
    const options = { category: 'otc' as const, mirror: false, logRecipient: false };
    const richMail = { ...mail, text: 'Plain body' };

    await expect(queuedMailer.sendEmail('a@example.org', richMail, options)).resolves.toEqual({
      messageId: 'smtp-1',
    });

    expect(mocks.mailerSend).toHaveBeenCalledTimes(1);
    expect(mocks.mailerSend).toHaveBeenCalledWith('a@example.org', richMail, options);
  });

  it('does not hand the delivery ref to the mailer, which has no use for it', async () => {
    await queuedMailer.sendEmail('a@example.org', mail, {
      mirror: false,
      ref: { kind: 'incidentAlert', incidentId: 'inc-1', alert: 'review' },
    });

    expect(mocks.mailerSend).toHaveBeenCalledWith('a@example.org', mail, { mirror: false });
  });

  it('passes an empty options object when the caller gave none', async () => {
    await queuedMailer.sendEmail('a@example.org', mail);

    expect(mocks.mailerSend).toHaveBeenCalledWith('a@example.org', mail, {});
  });

  it('leaves an array of recipients for the mailer to join', async () => {
    await queuedMailer.sendEmail(['a@example.org', 'b@example.org'], mail);

    expect(mocks.mailerSend).toHaveBeenCalledWith(['a@example.org', 'b@example.org'], mail, {});
  });

  it('returns false when the mailer reports a failed delivery', async () => {
    mocks.mailerSend.mockResolvedValue(false);

    await expect(queuedMailer.sendEmail('a@example.org', mail)).resolves.toBe(false);
  });

  it('hands over-limit mail to the mailer without storing the body', async () => {
    const big = { subject: 'Big', html: 'x'.repeat(300 * 1024) };
    await queuedMailer.sendEmail('a@example.org', big);
    expect(mocks.mailerSend).toHaveBeenCalledWith('a@example.org', big, {});
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('does not publish an event', async () => {
    await queuedMailer.sendEmail('a@example.org', mail);

    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('loads the SMTP mailer on demand, which is what the hosted path must never do', async () => {
    const fresh = await loadFreshQueuedMailer();
    expect(mocks.indexLoaded).not.toHaveBeenCalled();

    await fresh.sendEmail('a@example.org', mail);

    expect(mocks.indexLoaded).toHaveBeenCalledTimes(1);
  });
});
