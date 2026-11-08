import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  select: vi.fn(),
  sort: vi.fn(),
  limit: vi.fn(),
  maxTimeMS: vi.fn(),
  lean: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ ApiKeyUsageLog: { find: mocks.find } }));
import { apiRequestFilter, apiRequestToEntry, readApiRequests } from './userApiRequests';

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: mocks.select,
    sort: mocks.sort,
    limit: mocks.limit,
    maxTimeMS: mocks.maxTimeMS,
    lean: mocks.lean,
  };
  for (const mock of [mocks.find, mocks.select, mocks.sort, mocks.limit, mocks.maxTimeMS]) mock.mockReturnValue(chain);
  mocks.lean.mockResolvedValue([]);
});

describe('user API requests', () => {
  it('scopes the bounded read to the user and selected key, using timestamp and id for paging', async () => {
    const at = new Date('2026-11-01T12:00:00Z');
    const id = 'b'.repeat(24);
    const page = {
      limit: 30,
      apiKeyId: 'a'.repeat(24),
      cursor: { occurredAt: at, id },
      range: { from: new Date('2026-10-31'), to: at },
    };
    await readApiRequests('target-user', page);
    expect(mocks.find).toHaveBeenCalledWith({
      $and: [
        { userId: 'target-user', keyId: 'a'.repeat(24) },
        { timestamp: { $gte: page.range.from } },
        { timestamp: { $lte: at } },
        { $or: [{ timestamp: { $lt: at } }, { timestamp: at, _id: { $lt: new Types.ObjectId(id) } }] },
      ],
    });
    expect(mocks.sort).toHaveBeenCalledWith({ timestamp: -1, _id: -1 });
    expect(mocks.limit).toHaveBeenCalledWith(31);
    expect(mocks.maxTimeMS).toHaveBeenCalledWith(15_000);
    expect(mocks.select).toHaveBeenCalledWith(
      '_id timestamp keyId method endpoint statusCode responseTime ipAddress completionObservation'
    );
  });

  it('keeps all-key reads user scoped and propagates failed reads', async () => {
    expect(apiRequestFilter('u', { limit: 5, range: {} })).toEqual({ $and: [{ userId: 'u' }] });
    mocks.lean.mockRejectedValue(new Error('read failed'));
    await expect(readApiRequests('u', { limit: 5, range: {} })).rejects.toThrow('read failed');
  });

  it('keeps completion outcome separate from HTTP transport status', () => {
    const entry = apiRequestToEntry({
      _id: new Types.ObjectId(),
      timestamp: new Date(),
      keyId: 'key',
      method: 'POST',
      endpoint: '/api/ai/v1/completions',
      statusCode: 200,
      responseTime: 50,
      ipAddress: '203.0.113.1',
      completionObservation: {
        requestId: 'synthetic-request',
        requestedModel: 'model-alpha',
        startedAt: '2026-01-01T12:00:00Z',
        outcome: 'failed',
      },
    });
    expect(entry.request.statusCode).toBe(200);
    expect(entry.request.completionObservation?.outcome).toBe('failed');
    expect(entry.alert).toBe(true);
    expect(entry.detail).toContain('Failed / Requested: model-alpha');
  });

  it('uses the actual response result and strips legacy query and fragment values', () => {
    const row = {
      _id: new Types.ObjectId(),
      timestamp: new Date(),
      keyId: 'k',
      method: 'GET',
      endpoint: '/api/v1/me?token=private#secret',
      statusCode: 403,
      responseTime: 12,
      ipAddress: '203.0.113.1',
    };
    const entry = apiRequestToEntry(row);
    expect(entry.at).toBe(row.timestamp);
    expect(entry.summary).toBe('GET /api/v1/me - 403');
    expect(entry.detail).toContain(' ms ' + String.fromCodePoint(183) + ' ');
    expect(entry.alert).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('private');
    expect(JSON.stringify(entry)).not.toContain('secret');
    expect(entry.request).toMatchObject({ statusCode: 403, responseTimeMs: 12, keyId: 'k', ip: '203.0.113.1' });
  });
});
