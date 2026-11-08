import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { ApiKeyInfo } from '@server/cli/auth';

const mockLogUsage = vi.hoisted(() => vi.fn());
const mockBeginUsage = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: mockLogUsage, beginCompletionUsage: mockBeginUsage },
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '1.2.3.4' }));
vi.mock('@server/utils/resolveApiKeyOwnerType', () => ({ resolveApiKeyOwnerType: () => 'User' }));

import { logApiKeyUsageOnResponse } from './apiKeyUsageLog';

type FakeRes = EventEmitter & {
  headersSent: boolean;
  statusCode: number;
  destroyed: boolean;
  writableFinished: boolean;
};

const makeRes = (overrides: Partial<FakeRes> = {}): FakeRes =>
  Object.assign(new EventEmitter(), {
    headersSent: false,
    statusCode: 200,
    destroyed: false,
    writableFinished: false,
    ...overrides,
  });

const register = (res: FakeRes, completion?: Parameters<typeof logApiKeyUsageOnResponse>[0]['completion']) => {
  const track = vi.fn<(p: Promise<void>) => void>();
  const ready = logApiKeyUsageOnResponse({
    req: { method: 'POST' } as Request,
    res: res as unknown as Response,
    apiKey: { keyId: 'k1', userId: 'u1' } as ApiKeyInfo,
    endpoint: '/api/ai/v1/completions',
    source: 'api',
    startTime: Date.now(),
    completion,
    logger: { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
    track,
  });
  return { track, ready };
};

describe('logApiKeyUsageOnResponse', () => {
  beforeEach(() => {
    mockLogUsage.mockReset().mockResolvedValue(undefined);
    mockBeginUsage.mockReset().mockResolvedValue('log-id');
  });

  it('tracks synchronously and logs once when finish is followed by close', async () => {
    const res = makeRes({ headersSent: true, statusCode: 202 });
    const { track } = register(res);
    expect(track).toHaveBeenCalledTimes(2);

    res.emit('finish');
    res.emit('close');
    await Promise.resolve();

    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    expect(mockLogUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'k1',
        userId: 'u1',
        ipAddress: '1.2.3.4',
        endpoint: '/api/ai/v1/completions',
        method: 'POST',
        statusCode: 202,
        source: 'api',
        ownerType: 'User',
      })
    );
  });

  it('records 499 when the client closes before headers are sent', async () => {
    const res = makeRes();
    register(res);
    res.emit('close');
    await Promise.resolve();
    expect(mockLogUsage).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 499 }));
  });

  it('keeps the tracked promise pending until logUsage settles', async () => {
    const write = Promise.withResolvers<void>();
    mockLogUsage.mockReturnValueOnce(write.promise);
    const res = makeRes({ headersSent: true });
    const { track } = register(res);
    const tracked = track.mock.calls[1][0];
    const settled = vi.fn();
    void tracked.then(settled);

    res.emit('finish');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();

    write.resolve();
    await tracked;
    expect(settled).toHaveBeenCalled();
  });

  it('preserves daily-cap rejections with a start time and correlation id', async () => {
    const res = makeRes({ headersSent: true, statusCode: 429, writableFinished: true });
    register(res, {
      requestId: 'synthetic-request',
      requestedModel: 'model-alpha',
      outcome: () => 'daily_cap_rejected',
    });
    res.emit('finish');
    await Promise.resolve();
    expect(mockLogUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        completionObservation: expect.objectContaining({
          requestId: 'synthetic-request',
          requestedModel: 'model-alpha',
          outcome: 'daily_cap_rejected',
          startedAt: expect.any(String),
        }),
      })
    );
  });

  it('does not present an interrupted HTTP 200 stream as a successful completion', async () => {
    const res = makeRes({ headersSent: true, statusCode: 200 });
    register(res, { requestId: 'synthetic-request', requestedModel: 'model-alpha', outcome: () => 'unknown' });
    res.emit('close');
    await Promise.resolve();
    expect(mockLogUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 200,
        completionObservation: expect.objectContaining({ outcome: 'interrupted' }),
      })
    );
  });

  it('persists the unknown start before a response exists', async () => {
    const res = makeRes();
    const { ready } = register(res, {
      requestId: 'synthetic-request',
      requestedModel: 'model-alpha',
      outcome: () => 'unknown',
    });
    await ready;
    expect(mockBeginUsage).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 0, completionObservation: expect.objectContaining({ outcome: 'unknown' }) })
    );
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  it('does not recreate a start missing after purge', async () => {
    mockBeginUsage.mockResolvedValue(null);
    const res = makeRes({ headersSent: true });
    const { ready, track } = register(res, {
      requestId: 'synthetic-request',
      requestedModel: 'model-alpha',
      outcome: () => 'completed',
    });
    await ready;
    res.emit('finish');
    await track.mock.calls[1][0];
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  it('logs immediately when the response is already finished', async () => {
    const res = makeRes({ headersSent: true, writableFinished: true });
    register(res);
    await Promise.resolve();
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    res.emit('close');
    await Promise.resolve();
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
  });
});
