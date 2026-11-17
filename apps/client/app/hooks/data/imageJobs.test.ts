import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({ ReadyState: { OPEN: 1 }, useWebsocket: vi.fn() }));

const { imageJobRetryDelay, shouldRetryImageJob } = await import('./imageJobs');

const httpError = (status: number) =>
  new AxiosError('failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: null,
  });

describe('shouldRetryImageJob', () => {
  it('never retries a 404', () => {
    expect(shouldRetryImageJob(0, httpError(404))).toBe(false);
  });

  it('retries a 429 more times than other errors, but not forever', () => {
    expect(shouldRetryImageJob(4, httpError(429))).toBe(true);
    expect(shouldRetryImageJob(5, httpError(429))).toBe(false);
    expect(shouldRetryImageJob(2, httpError(500))).toBe(true);
    expect(shouldRetryImageJob(3, httpError(500))).toBe(false);
  });
});

describe('imageJobRetryDelay', () => {
  it('backs off exponentially up to a cap', () => {
    expect(imageJobRetryDelay(0)).toBe(1000);
    expect(imageJobRetryDelay(2)).toBe(4000);
    expect(imageJobRetryDelay(10)).toBe(30_000);
  });
});
