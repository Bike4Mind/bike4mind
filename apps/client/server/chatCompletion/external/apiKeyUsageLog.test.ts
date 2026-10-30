import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { ApiKeyInfo } from '@server/cli/auth';

const mockLogUsage = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: mockLogUsage },
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

const register = (res: FakeRes) => {
  const track = vi.fn<(p: Promise<void>) => void>();
  logApiKeyUsageOnResponse({
    req: { method: 'POST' } as Request,
    res: res as unknown as Response,
    apiKey: { keyId: 'k1', userId: 'u1' } as ApiKeyInfo,
    endpoint: '/api/ai/v1/completions',
    source: 'api',
    startTime: Date.now(),
    logger: {} as Logger,
    track,
  });
  return track;
};

describe('logApiKeyUsageOnResponse', () => {
  beforeEach(() => {
    mockLogUsage.mockReset().mockResolvedValue(undefined);
  });

  it('tracks synchronously and logs once when finish is followed by close', () => {
    const res = makeRes({ headersSent: true, statusCode: 202 });
    const track = register(res);
    expect(track).toHaveBeenCalledTimes(1);

    res.emit('finish');
    res.emit('close');

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

  it('records 499 when the client closes before headers are sent', () => {
    const res = makeRes();
    register(res);
    res.emit('close');
    expect(mockLogUsage).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 499 }));
  });

  it('keeps the tracked promise pending until logUsage settles', async () => {
    const write = Promise.withResolvers<void>();
    mockLogUsage.mockReturnValueOnce(write.promise);
    const res = makeRes({ headersSent: true });
    const track = register(res);
    const tracked = track.mock.calls[0][0];
    const settled = vi.fn();
    void tracked.then(settled);

    res.emit('finish');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();

    write.resolve();
    await tracked;
    expect(settled).toHaveBeenCalled();
  });

  it('logs immediately when the response is already finished', () => {
    const res = makeRes({ headersSent: true, writableFinished: true });
    register(res);
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    res.emit('close');
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
  });
});
