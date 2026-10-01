import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
const { connect, find, limit, lean, update } = vi.hoisted(() => ({
  connect: vi.fn(),
  find: vi.fn(),
  limit: vi.fn(),
  lean: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ connectDB: connect, Quest: { find, updateMany: update } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
import { handler, runTelemetryCleanup } from './telemetryCleanup';
const context = { awsRequestId: 'local-test', functionName: 'cleanup', functionVersion: '1' } as Context;
beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  find.mockReturnValue({ setOptions: () => ({ limit }) });
  limit.mockReturnValue({ lean });
  lean.mockResolvedValue([]);
});
describe('telemetry cleanup adapter', () => {
  it('keeps the hosted response, database connection and default batch size', async () => {
    const result = await handler(undefined as never, context);
    expect(connect).toHaveBeenCalledWith('mongodb://localhost/test', expect.anything());
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]);
    expect(limit).toHaveBeenCalledWith(5000);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ modifiedCount: 0, batches: 0, cutoff: expect.any(String) });
  });
  it('rethrows hosted database connection failures', async () => {
    connect.mockRejectedValueOnce(new Error('offline'));
    await expect(handler(undefined as never, context)).rejects.toThrow('offline');
    expect(find).not.toHaveBeenCalled();
  });
  it('uses the worker connection and rethrows local query failures', async () => {
    lean.mockRejectedValueOnce(new Error('query failed'));
    await expect(runTelemetryCleanup()).rejects.toThrow('query failed');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid batch size %s', async batchSize => {
    await expect(runTelemetryCleanup({ batchSize })).rejects.toThrow('Invalid telemetry cleanup batch size');
    expect(find).not.toHaveBeenCalled();
  });
});
