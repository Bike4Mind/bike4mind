import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToQueueMock, sendEmailMock } = vi.hoisted(() => ({
  sendToQueueMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('./sqs', () => ({ sendToQueue: sendToQueueMock }));
vi.mock('./mailer', () => ({ default: { sendEmail: sendEmailMock } }));

const { SessionEvents, EmailEvents } = await import('./eventBus');

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
    process.env.B4M_SELF_HOST = originalSelfHost;
    if (originalQueue === undefined) delete process.env.SELF_HOST_EVENT_QUEUE;
    else process.env.SELF_HOST_EVENT_QUEUE = originalQueue;
  });

  it('routes email.send to the mailer, not the event queue', async () => {
    delete process.env.SELF_HOST_EVENT_QUEUE;
    await EmailEvents.Send.publish({ to: 'a@b.com', subject: 'Hi', body: '<p>hello</p>' });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      'a@b.com',
      expect.objectContaining({ subject: 'Hi', html: '<p>hello</p>' })
    );
    expect(sendToQueueMock).not.toHaveBeenCalled();
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

  it('never throws when the enqueue fails', async () => {
    process.env.SELF_HOST_EVENT_QUEUE = 'http://sqs/selfHostEventQueue';
    sendToQueueMock.mockRejectedValue(new Error('sqs down'));
    await expect(SessionEvents.AutoName.publish({ sessionId: 's1', userId: 'u1' })).resolves.toBeUndefined();
  });
});
