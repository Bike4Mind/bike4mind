import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

import { createPostReport } from './slackChatTarget';

/**
 * Webhook poster - the accepted-vs-not classification the send dedupe's release rule
 * turns on. The asymmetry is deliberate: a wrong `notDelivered` re-pings the whole
 * channel, a wrong `unknown` only holds a reservation for the TTL, so anything
 * uncertain must resolve to `unknown`.
 */

const WEBHOOK = 'https://hooks.slack.com/services/T00000000/B00000000/example-webhook-token';
const DESTINATION = { webhookUrl: WEBHOOK };

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.mocked(logger.error).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchResolved(value: { ok: boolean; status: number }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(value));
}

function stubFetchRejected(error: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
}

describe('createPostReport - webhook delivery classification', () => {
  it('treats a 2xx as accepted', async () => {
    stubFetchResolved({ ok: true, status: 200 });
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect(result).toEqual({ accepted: true });
  });

  it('treats a 4xx as notDelivered - Slack read and declined the body', async () => {
    stubFetchResolved({ ok: false, status: 404 });
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect(result).toEqual({ accepted: false, delivery: 'notDelivered', reason: 'status=404' });
  });

  it('treats a 5xx as unknown - it may have accepted the post then failed on the way back', async () => {
    stubFetchResolved({ ok: false, status: 503 });
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect(result).toEqual({ accepted: false, delivery: 'unknown', reason: 'status=503' });
  });

  it('treats a name-resolution failure as notDelivered - it was never transmitted', async () => {
    stubFetchRejected(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect(result.accepted).toBe(false);
    expect((result as { delivery: string }).delivery).toBe('notDelivered');
  });

  it('treats a reset after send as unknown - the bytes may have landed', async () => {
    stubFetchRejected(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect(result.accepted).toBe(false);
    expect((result as { delivery: string }).delivery).toBe('unknown');
  });

  it('refuses a redirect - never follows it, and classifies it as notDelivered', async () => {
    // undici's default redirect:'follow' would resend the whole report body to the 3xx
    // target with no allowlist re-check. The post must pass redirect:'manual' and refuse.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createPostReport(logger)('digest', DESTINATION);

    expect(result.accepted).toBe(false);
    expect((result as { delivery: string }).delivery).toBe('notDelivered');
    // Exactly one request - the redirect Location is never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(WEBHOOK, expect.objectContaining({ redirect: 'manual' }));
  });

  it('refuses a raw 3xx status as a redirect', async () => {
    stubFetchResolved({ ok: false, status: 307 });
    const result = await createPostReport(logger)('digest', DESTINATION);
    expect((result as { delivery: string }).delivery).toBe('notDelivered');
  });

  it('never puts the webhook URL in the result or the log line', async () => {
    stubFetchRejected(Object.assign(new TypeError(`connect failed to ${WEBHOOK}`), { cause: { code: 'ECONNRESET' } }));
    const result = await createPostReport(logger)('digest', DESTINATION);

    expect(JSON.stringify(result)).not.toContain(WEBHOOK);
    expect(JSON.stringify(result)).not.toContain('example-webhook-token');
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain('example-webhook-token');
  });

  it('redacts a self-hosted webhook URL that does not match the Slack path shape', async () => {
    // The egress guard supports an operator-named host; its webhook path need not follow
    // /services/T.../B.../..., so the shape regex alone would leak it - the literal match must.
    const selfHosted = 'https://chat.internal.test/hooks/verysecretpath';
    stubFetchRejected(
      Object.assign(new TypeError(`connect failed to ${selfHosted}`), { cause: { code: 'ECONNRESET' } })
    );

    const result = await createPostReport(logger)('digest', { webhookUrl: selfHosted });

    expect(JSON.stringify(result)).not.toContain(selfHosted);
    expect(JSON.stringify(result)).not.toContain('verysecretpath');
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain('verysecretpath');
  });
});
