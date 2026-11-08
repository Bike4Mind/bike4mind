import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';

const { createMock, beginMock, finishMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  beginMock: vi.fn(),
  finishMock: vi.fn(),
}));
vi.mock('@bike4mind/database/auth', () => ({
  apiKeyUsageLogRepository: {
    create: createMock,
    beginCompletionObservation: beginMock,
    finishCompletionObservation: finishMock,
  },
}));

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

  it('persists a start then updates the same terminal row without creating a duplicate', async () => {
    beginMock.mockResolvedValue('start-id');
    const completionObservation = {
      requestId: 'synthetic-request',
      requestedModel: 'model-alpha',
      startedAt: '2026-01-01T12:00:00Z',
      outcome: 'unknown' as const,
    };
    expect(
      await ApiKeyUsageManager.beginCompletionUsage({
        ...baseParams,
        source: 'api',
        ownerType: CreditHolderType.User,
        completionObservation,
      })
    ).toBe('start-id');
    await ApiKeyUsageManager.logUsage({
      ...baseParams,
      source: 'api',
      ownerType: CreditHolderType.User,
      completionObservation: { ...completionObservation, outcome: 'completed' },
      existingLogId: 'start-id',
    });
    expect(finishMock).toHaveBeenCalledWith(
      'start-id',
      'user-1',
      expect.objectContaining({ completionObservation: expect.objectContaining({ outcome: 'completed' }) })
    );
    expect(createMock).not.toHaveBeenCalled();
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
