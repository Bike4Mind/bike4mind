import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import type { SQSEvent } from 'aws-lambda';
import { ApiKeyStatus, GENERATION_CALLBACK_EVENT_TYPE } from '@bike4mind/common';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  findCallbackById: vi.fn(),
  findById: vi.fn(),
  recordCallbackAttempt: vi.fn(),
  findCallbackSigningSecret: vi.fn(),
  sessionFindById: vi.fn(),
  assertUrlAllowed: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: {
    findCallbackById: h.findCallbackById,
    findById: h.findById,
    recordCallbackAttempt: h.recordCallbackAttempt,
  },
  userApiKeyRepository: {
    findCallbackSigningSecret: h.findCallbackSigningSecret,
  },
  sessionRepository: {
    findById: h.sessionFindById,
  },
  TERMINAL_QUEST_STATUSES: ['done', 'stopped'],
}));

vi.mock('@server/utils/ssrfProtection', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/ssrfProtection')>();
  return {
    ...actual,
    assertUrlAllowed: h.assertUrlAllowed,
  };
});

import { dispatch } from './generationCallback';
import { GENERATION_CALLBACK_MAX_RECEIVE_COUNT } from './sqsDelivery';
import { SsrfError } from '@server/utils/ssrfProtection';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() } as never;

function makeEvent(body: Record<string, unknown>, approximateReceiveCount = '1'): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify(body),
        attributes: { ApproximateReceiveCount: approximateReceiveCount },
      },
    ],
  } as unknown as SQSEvent;
}

const MESSAGE = { questId: 'quest-1', eventId: 'event-1' };

const CALLBACK_DISPATCHED = {
  url: 'https://receiver.example.com/hook',
  apiKeyId: 'key-1',
  eventId: 'event-1',
  state: 'dispatched',
};

const SIGNING_OWNER_ACTIVE = {
  secret: 'whsec_x',
  userId: 'owner-1',
  status: ApiKeyStatus.ACTIVE,
};

function makeQuest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quest-1',
    sessionId: 'session-1',
    status: 'done',
    type: 'text',
    reply: 'hello',
    replies: ['hello'],
    images: [],
    promptMeta: null,
    uiSideEffects: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:01:00.000Z'),
    attachmentNotices: [],
    attachmentDelivery: undefined,
    ...overrides,
  } as unknown as Parameters<typeof import('@server/utils/questPollBody').toQuestPollBody>[0];
}

type FetchMock = ReturnType<typeof vi.fn>;

function stubFetch(impl: FetchMock) {
  vi.stubGlobal('fetch', impl);
}

describe('generationCallback dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findCallbackById.mockResolvedValue(CALLBACK_DISPATCHED);
    h.findById.mockResolvedValue(makeQuest());
    h.findCallbackSigningSecret.mockResolvedValue(SIGNING_OWNER_ACTIVE);
    h.sessionFindById.mockResolvedValue({ userId: 'owner-1' });
    h.assertUrlAllowed.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('records delivered and sends a genuinely-verifiable signed POST on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', { state: 'delivered', statusCode: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CALLBACK_DISPATCHED.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Event-Type']).toBe(GENERATION_CALLBACK_EVENT_TYPE);
    expect(headers['X-Webhook-Event-ID']).toBe(CALLBACK_DISPATCHED.eventId);

    const body = init.body as string;
    const timestamp = headers['X-Webhook-Timestamp'];
    const expectedSignature = crypto
      .createHmac('sha256', SIGNING_OWNER_ACTIVE.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(headers['X-Webhook-Signature-256']).toBe(`sha256=${expectedSignature}`);
  });

  it('records dispatched and throws for SQS redelivery on a retryable failure (attempt 1)', async () => {
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).rejects.toThrow();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'dispatched',
      statusCode: 503,
      error: expect.any(String),
    });
  });

  it('records failed AND throws on a retryable failure at the final attempt, so SQS routes it to the DLQ', async () => {
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      dispatch(makeEvent(MESSAGE, String(GENERATION_CALLBACK_MAX_RECEIVE_COUNT)), {} as never, logger)
    ).rejects.toThrow();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: 503,
      error: expect.any(String),
    });
  });

  it('records failed without throwing on a 404 (permanent failure code) regardless of attempt number', async () => {
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: 404,
      error: expect.any(String),
    });
  });

  it.each([405, 409, 422])('records failed without throwing on any other 4xx (%i) at attempt 1', async status => {
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status }));

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: status,
      error: expect.any(String),
    });
  });

  it.each([408, 429])('treats a %i as retryable and throws for SQS redelivery', async status => {
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status }));

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).rejects.toThrow();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'dispatched',
      statusCode: status,
      error: expect.any(String),
    });
  });

  it('carries CDN-qualified files in the body when NEXT_PUBLIC_CDN_URL is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_CDN_URL', 'https://cdn.example.com');
    h.findById.mockResolvedValue(makeQuest({ images: ['render.png', 'clip.mp4'] }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { files: unknown };
    expect(body.files).toEqual([
      {
        name: 'render.png',
        url: 'https://cdn.example.com/generated/render.png',
        isImage: true,
        isAudio: false,
        isVideo: false,
      },
      {
        name: 'clip.mp4',
        url: 'https://cdn.example.com/generated/clip.mp4',
        isImage: false,
        isAudio: false,
        isVideo: true,
      },
    ]);
  });

  it('treats a 3xx as permanent (redirects are not followed) and calls fetch with redirect: manual', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302 });
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: 302,
      error: expect.any(String),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });

  it('treats a fetch rejection (timeout/network) as retryable and throws on attempt 1', async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error('network error')));

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).rejects.toThrow();

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'dispatched',
      statusCode: undefined,
      error: expect.any(String),
    });
  });

  it('fails permanently without calling fetch when the signing key is revoked', async () => {
    h.findCallbackSigningSecret.mockResolvedValue({ ...SIGNING_OWNER_ACTIVE, status: ApiKeyStatus.DISABLED });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: expect.any(String),
    });
  });

  it('fails permanently without calling fetch when the signing key has expired', async () => {
    h.findCallbackSigningSecret.mockResolvedValue({
      ...SIGNING_OWNER_ACTIVE,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: expect.any(String),
    });
  });

  it('fails permanently without calling fetch when there is no signing secret at all', async () => {
    h.findCallbackSigningSecret.mockResolvedValue(null);
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: expect.any(String),
    });
  });

  it('is a no-op when the callback is already delivered', async () => {
    h.findCallbackById.mockResolvedValue({ ...CALLBACK_DISPATCHED, state: 'delivered' });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).not.toHaveBeenCalled();
  });

  it('is a no-op when the callback is still pending (not dispatched yet)', async () => {
    h.findCallbackById.mockResolvedValue({ ...CALLBACK_DISPATCHED, state: 'pending' });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no callback on the quest at all', async () => {
    h.findCallbackById.mockResolvedValue(null);
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).not.toHaveBeenCalled();
  });

  it('DOES attempt delivery when the callback state is failed (a DLQ replay)', async () => {
    h.findCallbackById.mockResolvedValue({ ...CALLBACK_DISPATCHED, state: 'failed' });
    stubFetch(vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', { state: 'delivered', statusCode: 200 });
  });

  it('fails permanently without calling fetch when assertUrlAllowed throws SsrfError', async () => {
    h.assertUrlAllowed.mockRejectedValue(new SsrfError('points to a private or internal network'));
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: expect.any(String),
    });
  });

  it('sends the non-owner-redacted promptMeta shape when the session owner differs from the signing key owner', async () => {
    h.findById.mockResolvedValue(
      makeQuest({
        promptMeta: {
          functionCalls: [{ name: 'search', returnValue: 'owner-private-search-result' }],
        },
      })
    );
    h.sessionFindById.mockResolvedValue({ userId: 'someone-else' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      promptMeta: { functionCalls: Array<Record<string, unknown>> };
    };
    expect(sentBody.promptMeta.functionCalls[0]).not.toHaveProperty('returnValue');
    expect(sentBody.promptMeta.functionCalls[0]).toMatchObject({ name: 'search' });
  });

  it('is a no-op when the message eventId no longer matches the callback (re-armed since enqueue)', async () => {
    h.findCallbackById.mockResolvedValue({ ...CALLBACK_DISPATCHED, eventId: 'event-2' });
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await dispatch(makeEvent(MESSAGE), {} as never, logger);

    expect(h.findById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).not.toHaveBeenCalled();
  });

  it('records failed without fetching when the quest is no longer terminal (re-run after dispatch)', async () => {
    h.findById.mockResolvedValue(makeQuest({ status: 'running' }));
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: 'Quest is no longer settled; it was re-run after this callback was dispatched',
    });
  });

  it('records failed without fetching when the quest status is undefined (re-run after dispatch)', async () => {
    h.findById.mockResolvedValue(makeQuest({ status: undefined }));
    const fetchMock = vi.fn();
    stubFetch(fetchMock);

    await expect(dispatch(makeEvent(MESSAGE, '1'), {} as never, logger)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.recordCallbackAttempt).toHaveBeenCalledWith('quest-1', 'event-1', {
      state: 'failed',
      statusCode: undefined,
      error: 'Quest is no longer settled; it was re-run after this callback was dispatched',
    });
  });
});
