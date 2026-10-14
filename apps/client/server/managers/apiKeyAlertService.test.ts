import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findByIdMock, createAlertMock } = vi.hoisted(() => ({ findByIdMock: vi.fn(), createAlertMock: vi.fn() }));

vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: { findById: findByIdMock },
  apiKeyAlertRepository: { createAlert: createAlertMock },
}));
vi.mock('./apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { getRecentRequestsPerMinute: vi.fn().mockResolvedValue(0) },
}));

import { ApiKeyAlertService } from './apiKeyAlertService';

const baseline = {
  lastCalculatedAt: new Date(),
  commonIPs: ['1.2.3.4'],
  commonEndpoints: ['/api/agents'],
  avgRequestsPerHour: 1,
};

const detect = (endpoint: string, pathname?: string) =>
  ApiKeyAlertService.detectAnomalies({
    userId: 'u1',
    keyId: 'k1',
    ipAddress: '1.2.3.4',
    endpoint,
    pathname,
    timestamp: new Date(),
  });

describe('ApiKeyAlertService sensitive-endpoint check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByIdMock.mockResolvedValue({ userId: 'u1', metadata: { baseline } });
  });

  it('alerts on a sensitive endpoint outside the baseline', async () => {
    await detect('/api/admin/gears/[key]');
    expect(createAlertMock).toHaveBeenCalledWith('u1', 'k1', 'unusual_pattern', expect.any(String), {
      endpoint: '/api/admin/gears/[key]',
    });
  });

  it('judges sensitivity from the raw path even when the templated endpoint lost the prefix', async () => {
    await detect('/api/[key]/gears/admin', '/api/admin/gears/admin');
    expect(createAlertMock).toHaveBeenCalledOnce();
  });

  it('does not alert on a non-sensitive endpoint outside the baseline', async () => {
    await detect('/api/files/[id]', '/api/files/abc');
    expect(createAlertMock).not.toHaveBeenCalled();
  });
});
