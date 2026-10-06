import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
const { connect, find, update, calculate } = vi.hoisted(() => ({
  connect: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  calculate: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ connectDB: connect, userApiKeyRepository: { find, updateBaseline: update } }));
vi.mock('@server/managers/apiKeyUsageManager', () => ({ ApiKeyUsageManager: { calculateBaseline: calculate } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
import { handler, runApiKeyBaselineCalculation } from './apiKeyBaselineCalculation';
const context = { awsRequestId: 'local', functionName: 'baseline', functionVersion: '1' } as Context;
beforeEach(() => {
  vi.resetAllMocks();
  connect.mockResolvedValue(undefined);
  find.mockResolvedValue([]);
});
describe('API key baseline adapters', () => {
  it('preserves hosted connection and empty result', async () => {
    expect(await handler(undefined as never, context)).toEqual({
      status: 'success',
      processed: 0,
      skipped: 0,
      errors: 0,
      total: 0,
    });
    expect(connect).toHaveBeenCalledWith('mongodb://localhost/test', expect.anything());
    expect(find).toHaveBeenCalledWith({ status: 'active' });
  });
  it('preserves hosted error response while the shared runner rejects global failures', async () => {
    find.mockRejectedValue(new Error('query unavailable'));
    await expect(runApiKeyBaselineCalculation()).rejects.toThrow('query unavailable');
    expect(connect).not.toHaveBeenCalled();
    expect(await handler(undefined as never, context)).toMatchObject({
      status: 'error',
      reason: 'query unavailable',
      stack: expect.any(String),
    });
  });
  it('preserves hosted success with per-key errors and continues other keys', async () => {
    find.mockResolvedValue([
      { id: 'first', userId: 'owner' },
      { id: 'second', userId: 'owner' },
    ]);
    calculate.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(null);
    expect(await handler(undefined as never, context)).toEqual({
      status: 'success',
      processed: 0,
      skipped: 1,
      errors: 1,
      total: 2,
    });
    expect(calculate).toHaveBeenCalledTimes(2);
  });
});
