import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCachedData, mockGetOperationsModel } = vi.hoisted(() => ({
  mockGetCachedData: vi.fn(),
  mockGetOperationsModel: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ cacheRepository: {} }));
vi.mock('@bike4mind/services', () => ({ cacheService: { getCachedData: mockGetCachedData } }));
vi.mock('@bike4mind/services/llm/refineText', () => ({ refineText: vi.fn() }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mockGetOperationsModel },
  OperationsModelUnavailableError: class OperationsModelUnavailableError extends Error {},
}));

import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { refineTextRequest } from './refineTextRequest';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('refineTextRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedData.mockResolvedValue('refined');
  });

  it('refuses a moderated user before the cache, so a cached refinement is not served either', async () => {
    await expect(refineTextRequest({ text: 'hello' }, { logger, user: { isModerated: true } })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockGetCachedData).not.toHaveBeenCalled();
    expect(mockGetOperationsModel).not.toHaveBeenCalled();
  });

  it('serves an unmoderated user through the cache', async () => {
    await expect(refineTextRequest({ text: 'hello' }, { logger, user: { isModerated: false } })).resolves.toBe(
      'refined'
    );
    expect(mockGetCachedData).toHaveBeenCalledTimes(1);
  });
});
