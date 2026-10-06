import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToQueueMock, sendEmailMock, hostedSend } = vi.hoisted(() => ({
  sendToQueueMock: vi.fn(),
  sendEmailMock: vi.fn(),
  hostedSend: vi.fn(),
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

vi.mock('./mailer', () => ({ default: { sendEmail: sendEmailMock } }));

const { SessionEvents, EmailEvents, NotebookCurationEvents } = await import('./eventBus');

const startDetail = { sessionId: 's1', userId: 'u1', curationJobId: 'j1' };

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
