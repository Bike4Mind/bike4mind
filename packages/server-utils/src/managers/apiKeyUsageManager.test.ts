import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@bike4mind/database/auth', () => ({ apiKeyUsageLogRepository: { create: createMock } }));

import { ApiKeyUsageManager } from './apiKeyUsageManager';

const baseParams = {
  keyId: 'key-1',
  userId: 'user-1',
  ipAddress: '203.0.113.7',
  endpoint: '/api/chat',
  method: 'POST',
  responseTime: 42,
  statusCode: 200,
};

describe('ApiKeyUsageManager.logUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ id: 'log-1' });
  });

  it('persists source and ownerType on the usage log row', async () => {
    await ApiKeyUsageManager.logUsage({ ...baseParams, source: 'cli', ownerType: CreditHolderType.Organization });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key-1', source: 'cli', ownerType: CreditHolderType.Organization })
    );
  });

  it('does not throw when the repository write fails', async () => {
    createMock.mockRejectedValue(new Error('db down'));

    await expect(
      ApiKeyUsageManager.logUsage({ ...baseParams, source: 'api', ownerType: CreditHolderType.User })
    ).resolves.toBeUndefined();
  });
});
