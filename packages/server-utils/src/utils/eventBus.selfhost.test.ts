import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSendDetail } from './eventBus';

const { sendToQueueMock, sendEmailMock, hostedSend, recordOutcomeMock } = vi.hoisted(() => ({
  sendToQueueMock: vi.fn(),
  sendEmailMock: vi.fn(),
  hostedSend: vi.fn(),
  recordOutcomeMock: vi.fn(),
}));

vi.mock('./sqs', () => ({ sendToQueue: sendToQueueMock }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = hostedSend;
  },
  PutEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('sst', () => ({ Resource: { App: { name: 'local' }, AppEventBus: { name: 'events' } } }));

vi.mock('./mailer/index', () => ({ default: { sendEmail: sendEmailMock } }));
vi.mock('./mailer/deliveryOutcome', () => ({ recordEmailDeliveryOutcome: recordOutcomeMock }));

const { SessionEvents, EmailEvents, NotebookCurationEvents, StripeEvents } = await import('./eventBus');

const startDetail = { sessionId: 's1', userId: 'u1', curationJobId: 'j1' };

describe('EmailEvents.Send schema', () => {
  it('keeps text, mirror and logRecipient instead of stripping them', () => {
    const detail = {
      to: 'a@b.com',
      subject: 'Hi',
      body: '<p>hello</p>',
      text: 'hello',
      category: 'otc' as const,
      mirror: false,
      logRecipient: false,
    };

    expect(EmailEvents.Send.schema.parse(detail)).toEqual(detail);
  });

  it('keeps an attempt or incident-alert delivery ref', () => {
    const base = { to: 'a@b.com', subject: 'Hi', body: '<p>hello</p>' };
    const attempt = { ...base, ref: { kind: 'emailAttempt' as const, attemptId: 'att-1' } };
    const alert = {
      ...base,
      ref: { kind: 'incidentAlert' as const, incidentId: 'inc-1', alert: 'escalation' as const },
    };

    expect(EmailEvents.Send.schema.parse(attempt)).toEqual(attempt);
    expect(EmailEvents.Send.schema.parse(alert)).toEqual(alert);
  });

  it.each([
    ['an unknown kind', { kind: 'invoice', attemptId: 'att-1' }],
    ['an empty attempt id', { kind: 'emailAttempt', attemptId: '' }],
    ['an empty incident id', { kind: 'incidentAlert', incidentId: '', alert: 'review' }],
    ['an unknown alert', { kind: 'incidentAlert', incidentId: 'inc-1', alert: 'digest' }],
  ])('rejects a ref with %s', (_label, ref) => {
    expect(EmailEvents.Send.schema.safeParse({ to: 'a@b.com', subject: 'Hi', body: 'x', ref }).success).toBe(false);
  });

  it('does not require any of the optional fields', () => {
    const detail = { to: 'a@b.com', subject: 'Hi', body: '<p>hello</p>' };

    expect(EmailEvents.Send.schema.parse(detail)).toEqual(detail);
  });

  const bodyRef = { key: 'queued-mail/0b6f8a52-3c1e-4f7d-9a0b-2d4c6e8f1a3b.json' };
  const accepts = (detail: object) => EmailEvents.Send.schema.safeParse(detail).success;

  it('accepts a stored body reference in place of the body', () => {
    expect(accepts({ to: 'a@b.com', subject: 'Hi', bodyRef })).toBe(true);
  });

  it('accepts an empty body', () => {
    expect(accepts({ to: 'a@b.com', subject: 'Hi', body: '' })).toBe(true);
  });

  it('rejects mail with both a body and a reference, or with neither', () => {
    expect(accepts({ to: 'a@b.com', subject: 'Hi', body: '<p>hello</p>', bodyRef })).toBe(false);
    expect(accepts({ to: 'a@b.com', subject: 'Hi' })).toBe(false);
  });

  it('rejects a text alternative next to a reference, since the stored body carries it', () => {
    expect(accepts({ to: 'a@b.com', subject: 'Hi', bodyRef, text: 'hello' })).toBe(false);
  });

  it('rejects a reference outside the mail body prefix', () => {
    expect(accepts({ to: 'a@b.com', subject: 'Hi', bodyRef: { key: 'queued-mail/../profile-photos/x.json' } })).toBe(
      false
    );
    expect(accepts({ to: 'a@b.com', subject: 'Hi', bodyRef: { key: 'transcripts/0b6f8a52.json' } })).toBe(false);
  });
});

describe('eventBus publishSelfHost', () => {
  const originalSelfHost = process.env.B4M_SELF_HOST;
  const originalQueue = process.env.SELF_HOST_EVENT_QUEUE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    sendToQueueMock.mockResolvedValue('msg-1');
    sendEmailMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (originalSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = originalSelfHost;
    if (originalQueue === undefined) delete process.env.SELF_HOST_EVENT_QUEUE;
    else process.env.SELF_HOST_EVENT_QUEUE = originalQueue;
  });

  it('routes email.send to the mailer, not the event queue', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await EmailEvents.Send.publish({ to: 'a@b.com', subject: 'Hi', body: '<p>hello</p>' });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      'a@b.com',
      expect.objectContaining({ subject: 'Hi', html: '<p>hello</p>' }),
      {}
    );
    expect(sendEmailMock.mock.calls[0][1]).not.toHaveProperty('text');
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('types a publish with neither or both of body and bodyRef as an error, as the schema rejects them', () => {
    const bodyRef = { key: 'queued-mail/0b6f8a52-3c1e-4f7d-9a0b-2d4c6e8f1a3b.json' };
    // @ts-expect-error neither body nor bodyRef
    const neither: EmailSendDetail = { to: 'a@b.com', subject: 'Hi' };
    // @ts-expect-error both body and bodyRef
    const both: EmailSendDetail = { to: 'a@b.com', subject: 'Hi', body: 'x', bodyRef };
    // @ts-expect-error text travels in the stored body
    const textWithRef: EmailSendDetail = { to: 'a@b.com', subject: 'Hi', text: 't', bodyRef };
    for (const detail of [neither, both, textWithRef]) {
      expect(EmailEvents.Send.schema.safeParse(detail).success).toBe(false);
    }
  });

  it('refuses a stored body reference instead of mailing an empty body', async () => {
    await expect(
      EmailEvents.Send.publish({
        to: 'a@b.com',
        subject: 'Hi',
        bodyRef: { key: 'queued-mail/0b6f8a52-3c1e-4f7d-9a0b-2d4c6e8f1a3b.json' },
      })
    ).rejects.toThrow('email.send needs an inline body on self-host: bodyRef is hosted-only');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('passes the plain-text body and the send options through to the mailer', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await EmailEvents.Send.publish({
      to: 'a@b.com',
      subject: 'Hi',
      body: '<p>hello</p>',
      text: 'hello',
      category: 'otc',
      mirror: false,
      logRecipient: false,
      attachments: [{ filename: 'a.txt', content: Buffer.from('hi').toString('base64'), contentType: 'text/plain' }],
    });

    expect(sendEmailMock).toHaveBeenCalledExactlyOnceWith(
      'a@b.com',
      {
        subject: 'Hi',
        html: '<p>hello</p>',
        text: 'hello',
        attachments: [{ filename: 'a.txt', content: Buffer.from('hi'), contentType: 'text/plain' }],
      },
      { category: 'otc', mirror: false, logRecipient: false }
    );
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it.each([
    ['sent', { messageId: 'smtp-1' }, { ok: true, at: expect.any(Date) }],
    ['failed', false, { ok: false, error: expect.any(String) }],
  ])('records a %s delivery against the ref of a direct publish', async (_label, mailResult, outcome) => {
    sendEmailMock.mockResolvedValue(mailResult);
    const ref = { kind: 'emailAttempt' as const, attemptId: 'att-1' };

    await EmailEvents.Send.publish({ to: 'a@b.com', subject: 'Hi', body: 'x', ref });

    expect(recordOutcomeMock).toHaveBeenCalledExactlyOnceWith(ref, outcome);
  });

  it('records nothing for a self-host email without a ref', async () => {
    await EmailEvents.Send.publish({ to: 'a@b.com', subject: 'Hi', body: 'x' });
    expect(recordOutcomeMock).not.toHaveBeenCalled();
  });

  it('enqueues a non-email event to SELF_HOST_EVENT_QUEUE as { detailType, detail }', async () => {
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    await SessionEvents.AutoName.publish({ sessionId: 's1', userId: 'u1' });

    expect(sendToQueueMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).toHaveBeenCalledWith('http://sqs/selfHostEventQueue', {
      detailType: 'session.auto_name',
      detail: { sessionId: 's1', userId: 'u1' },
    });
  });

  it('warns and drops (does not throw) when SELF_HOST_EVENT_QUEUE is unset', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await expect(SessionEvents.AutoName.publish({ sessionId: 's1', userId: 'u1' })).resolves.toBeUndefined();
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a required-acceptance publish when the queue is unset', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await expect(NotebookCurationEvents.Start.publish(startDetail, { requireAcceptance: true })).rejects.toThrow(
      'SELF_HOST_EVENT_QUEUE'
    );
  });

  it('propagates broker errors only for a required-acceptance publish', async () => {
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    sendToQueueMock.mockRejectedValue(new Error('broker unavailable'));
    await expect(NotebookCurationEvents.Start.publish(startDetail, { requireAcceptance: true })).rejects.toThrow(
      'broker unavailable'
    );
    await expect(SessionEvents.AutoName.publish({ sessionId: 's1', userId: 'u1' })).resolves.toBeUndefined();
  });

  it('keeps the same event best-effort when the caller does not opt in (background spider)', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await expect(NotebookCurationEvents.Start.publish(startDetail)).resolves.toBeUndefined();
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    sendToQueueMock.mockRejectedValue(new Error('broker unavailable'));
    await expect(NotebookCurationEvents.Start.publish(startDetail)).resolves.toBeUndefined();
  });

  it.each([
    () =>
      StripeEvents.InvoicePaymentSucceeded.publish(
        { invoiceId: 'in_1', subscriptionId: 'sub_1' },
        { requireAcceptance: true }
      ),
    () => StripeEvents.CustomerSubscriptionUpdated.publish({ subscriptionId: 'sub_1' }, { requireAcceptance: true }),
  ])('rejects billing delivery when the queue is missing or unavailable', async publish => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await expect(publish()).rejects.toThrow('SELF_HOST_EVENT_QUEUE');
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    sendToQueueMock.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(publish()).rejects.toThrow('broker unavailable');
    await expect(publish()).resolves.toBeUndefined();
  });

  it('keeps other notebook curation events best-effort', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    const ids = { sessionId: 's1', userId: 'u1', curationJobId: 'j1' };
    await expect(
      NotebookCurationEvents.Progress.publish({ ...ids, stage: 'loading', percentage: 10 })
    ).resolves.toBeUndefined();
    await expect(
      NotebookCurationEvents.Complete.publish({
        ...ids,
        curatedFileId: 'f1',
        artifactCount: 0,
        messageCount: 1,
        tokensProcessed: 1,
      })
    ).resolves.toBeUndefined();
    await expect(
      NotebookCurationEvents.Error.publish({ ...ids, error: 'boom', stage: 'storing' })
    ).resolves.toBeUndefined();
  });

  it('keeps the hosted publisher result and rejection contract unchanged', async () => {
    process.env.B4M_SELF_HOST = 'false';
    hostedSend.mockResolvedValueOnce({ FailedEntryCount: 0 });
    await expect(NotebookCurationEvents.Start.publish(startDetail, { requireAcceptance: true })).resolves.toEqual({
      FailedEntryCount: 0,
    });
    hostedSend.mockRejectedValueOnce(new Error('hosted unavailable'));
    await expect(NotebookCurationEvents.Start.publish(startDetail, { requireAcceptance: true })).rejects.toThrow(
      'hosted unavailable'
    );
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('never throws when the enqueue fails', async () => {
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    sendToQueueMock.mockRejectedValue(new Error('sqs down'));
    await expect(SessionEvents.AutoName.publish({ sessionId: 's1', userId: 'u1' })).resolves.toBeUndefined();
  });
});
