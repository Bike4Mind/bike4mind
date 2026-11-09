import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { abuseAssessmentRequestActivitySchema, RISK_EVIDENCE_WINDOW_DAYS } from '@bike4mind/common';
import type { ApiRequestRow } from '@server/utils/userApiRequests';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@server/utils/userApiRequests', () => ({ readApiRequests: mocks.read }));
import { collectRequestActivity, REQUEST_ACTIVITY_SCAN_LIMIT, summarizeRequestRows } from './requestActivity';

const row = (overrides: Partial<ApiRequestRow> = {}): ApiRequestRow => ({
  _id: new Types.ObjectId(),
  timestamp: new Date(),
  keyId: 'private-key',
  method: 'GET',
  endpoint: '/api/v1/me',
  statusCode: 200,
  responseTime: 10,
  ipAddress: '203.0.113.1',
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe('API request evidence', () => {
  it('separates identity checks, admin routes and actual outcomes without sending raw data', () => {
    const result = summarizeRequestRows([
      row({ endpoint: '/api/v1/me?secret=private' }),
      row({ endpoint: '/api/%61dmin/users', statusCode: 403 }),
      row({ endpoint: '/api/administer', statusCode: 401 }),
      row({ endpoint: '/api/chat', statusCode: 429 }),
      row({ endpoint: '/api/chat', statusCode: 503 }),
    ]);
    expect(result).toMatchObject({
      status: 'observed',
      sampleCount: 5,
      coverage: 'partial_api_key_log',
      successful: 1,
      successfulIdentityChecks: 1,
      adminRequests: 1,
      forbidden: 1,
      unauthorized: 1,
      rateLimited: 1,
      serverErrors: 1,
      truncated: false,
    });
    expect(abuseAssessmentRequestActivitySchema.safeParse(result).success).toBe(true);
    for (const raw of ['private', '/api/', '203.0.113.1']) expect(JSON.stringify(result)).not.toContain(raw);
  });

  it('marks a bounded sample as truncated and does not count the sentinel', () => {
    const result = summarizeRequestRows(Array.from({ length: REQUEST_ACTIVITY_SCAN_LIMIT + 1 }, () => row()));
    expect(result).toMatchObject({
      sampleCount: REQUEST_ACTIVITY_SCAN_LIMIT,
      successful: REQUEST_ACTIVITY_SCAN_LIMIT,
      truncated: true,
    });
  });

  it('keeps partial coverage explicit when there are no retained requests', () => {
    expect(summarizeRequestRows([])).toMatchObject({
      status: 'observed',
      sampleCount: 0,
      adminRequests: 0,
      coverage: 'partial_api_key_log',
    });
  });

  it('bounds the source query and marks a failed read unknown with a diagnostic', async () => {
    const logger = { warn: vi.fn() };
    mocks.read.mockRejectedValue(new Error('private diagnostic'));
    const detectedAt = new Date('2026-11-01T12:00:00Z');
    expect(await collectRequestActivity('u', detectedAt, logger as never)).toEqual({ status: 'failed' });
    expect(mocks.read).toHaveBeenCalledWith('u', expect.objectContaining({ limit: REQUEST_ACTIVITY_SCAN_LIMIT }));
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { userId: 'u', errorName: 'Error' });
  });

  it('anchors the evidence window to the detection time, not the current time', async () => {
    mocks.read.mockResolvedValue([]);
    const detectedAt = new Date('2026-11-01T12:00:00Z');
    await collectRequestActivity('u', detectedAt, { warn: vi.fn() } as never);
    const { range } = mocks.read.mock.calls[0][1];
    expect(range.to).toEqual(detectedAt);
    expect(range.from).toEqual(new Date(detectedAt.getTime() - RISK_EVIDENCE_WINDOW_DAYS * 86_400_000));
  });
});
