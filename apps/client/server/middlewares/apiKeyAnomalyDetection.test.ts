import { describe, it, expect, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('./apiKeyAuth', () => ({ isApiKeyAuth: () => true }));
vi.mock('@server/managers/apiKeyAlertService', () => ({ ApiKeyAlertService: vi.fn() }));

import { apiKeyAnomalyDetection } from './apiKeyAnomalyDetection';

const run = async (scopes: ApiKeyScope[]) => {
  const res = { once: vi.fn() };
  const next = vi.fn();
  const req = { apiKeyInfo: { keyId: 'k1', scopes }, _apiKeyUsageInfo: { userId: 'u1', ipAddress: '1.2.3.4' } };
  await apiKeyAnomalyDetection()(req as never, res as never, next);
  return { res, next };
};

describe('apiKeyAnomalyDetection', () => {
  it('skips qa:ingest keys (CI runners have ephemeral IPs)', async () => {
    const { res, next } = await run([ApiKeyScope.QA_INGEST]);
    expect(next).toHaveBeenCalledOnce();
    expect(res.once).not.toHaveBeenCalled();
  });
  it('still schedules detection for ordinary keys', async () => {
    const { res } = await run([ApiKeyScope.AI_CHAT]);
    expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
  });
});
