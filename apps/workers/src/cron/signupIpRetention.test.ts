import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
const { connect, find, bulkWrite, rows } = vi.hoisted(() => ({
  connect: vi.fn(),
  find: vi.fn(),
  bulkWrite: vi.fn(),
  rows: { current: [] as Array<{ _id: string; signupMeta?: { ip: string | null } }> },
}));
vi.mock('@bike4mind/database', () => ({
  AUTH_EVENT_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  connectDB: connect,
  User: { find, bulkWrite },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
import { handler, runSignupIpRetention } from './signupIpRetention';
const context = { awsRequestId: 'local-test', functionName: 'retention', functionVersion: '1' } as Context;

async function* iterate<T>(items: T[]) {
  yield* items;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.current = [];
  connect.mockResolvedValue(undefined);
  find.mockImplementation(() => ({ lean: () => ({ cursor: () => iterate(rows.current) }) }));
  bulkWrite.mockImplementation(async (ops: unknown[]) => ({ modifiedCount: ops.length }));
});

describe('signup IP retention adapter', () => {
  it('connects before querying and returns the hosted response', async () => {
    const result = await handler(undefined as never, context);
    expect(connect).toHaveBeenCalledWith('mongodb://localhost/test', expect.anything());
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ truncatedCount: 0, batches: 0, cutoff: expect.any(String) });
  });

  it('rethrows hosted database connection failures', async () => {
    connect.mockRejectedValueOnce(new Error('offline'));
    await expect(handler(undefined as never, context)).rejects.toThrow('offline');
    expect(find).not.toHaveBeenCalled();
  });

  it('queries string IPs on signups older than the 90-day AuthEvent window', async () => {
    const now = new Date('2026-10-26T00:00:00Z');
    await runSignupIpRetention({ now });
    expect(find).toHaveBeenCalledExactlyOnceWith(
      {
        'signupMeta.capturedAt': { $exists: true, $lt: new Date('2026-07-28T00:00:00Z') },
        'signupMeta.ip': { $type: 'string' },
      },
      { 'signupMeta.ip': 1 }
    );
  });

  it('truncates IPv4 to /24 and IPv6 to /48, conditioned on the IP it read', async () => {
    rows.current = [
      { _id: 'v4', signupMeta: { ip: '203.0.113.42' } },
      { _id: 'v6', signupMeta: { ip: '2001:db8:abcd:12::1' } },
    ];
    const result = await runSignupIpRetention();
    expect(bulkWrite).toHaveBeenCalledExactlyOnceWith(
      [
        {
          updateOne: {
            filter: { _id: 'v4', 'signupMeta.ip': '203.0.113.42' },
            update: { $set: { 'signupMeta.ip': '203.0.113.0' } },
            timestamps: false,
          },
        },
        {
          updateOne: {
            filter: { _id: 'v6', 'signupMeta.ip': '2001:db8:abcd:12::1' },
            update: { $set: { 'signupMeta.ip': '2001:db8:abcd:0:0:0:0:0' } },
            timestamps: false,
          },
        },
      ],
      { ordered: false }
    );
    expect(result.truncatedCount).toBe(2);
  });

  it('skips rows with no IP or an IP truncation cannot shorten, warning only about non-addresses', async () => {
    rows.current = [
      { _id: 'done-v4', signupMeta: { ip: '203.0.113.0' } },
      { _id: 'done-v6', signupMeta: { ip: '2001:db8:abcd:0:0:0:0:0' } },
      { _id: 'odd', signupMeta: { ip: 'not-an-ip' } },
      { _id: 'colon-junk', signupMeta: { ip: 'a:b' } },
      { _id: 'null', signupMeta: { ip: null } },
    ];
    const logger = { log: vi.fn(), warn: vi.fn() } as unknown as Logger;
    expect(await runSignupIpRetention({ logger })).toMatchObject({ truncatedCount: 0, batches: 0 });
    expect(bulkWrite).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('2 signup IPs'));
  });

  it('flushes a write per full batch and one for the remainder', async () => {
    rows.current = Array.from({ length: 5 }, (_, i) => ({ _id: `u${i}`, signupMeta: { ip: `198.51.100.${i + 1}` } }));
    const result = await runSignupIpRetention({ batchSize: 2 });
    expect(bulkWrite.mock.calls.map(([ops]) => ops.length)).toEqual([2, 2, 1]);
    expect(result).toMatchObject({ truncatedCount: 5, batches: 3 });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid batch size %s', async batchSize => {
    await expect(runSignupIpRetention({ batchSize })).rejects.toThrow('Invalid signup IP retention batch size');
    expect(find).not.toHaveBeenCalled();
  });
});
