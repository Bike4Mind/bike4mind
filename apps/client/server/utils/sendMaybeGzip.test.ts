import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { Request, Response } from 'express';

const mockEmitMetrics = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetrics: (...args: unknown[]) => mockEmitMetrics(...args),
}));

// NOTE: the "gzipSync throws -> no Content-Encoding set, nothing flushed" ordering guarantee in
// sendMaybeGzip is not unit-tested here. Under this package's jsdom vitest environment a node:
// builtin cannot be intercepted for the module under test (vi.mock does not reach it, and the
// zlib namespace is non-configurable so vi.spyOn fails). The guarantee is enforced structurally:
// gzipSync is called before Content-Encoding is set and before res.end(). Setting Vary earlier is
// fine (setHeader never flushes); it is specifically the encoding header and the body that must
// not land before compression succeeds. Keep that ordering when editing the helper.

import {
  GZIP_THRESHOLD_BYTES,
  LARGE_API_RESPONSE_METRIC,
  LARGE_RESPONSE_BYTES_THRESHOLD,
  LARGE_UNCOMPRESSED_API_RESPONSE_METRIC,
  sendMaybeGzip,
} from '@server/utils/sendMaybeGzip';

function makeReq(acceptEncoding?: string): Request {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return {
    logger,
    url: '/api/users/counterLogs?startDate=2026-07-01',
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  } as unknown as Request;
}

// Node lowercases header names internally, so setHeader('vary') and getHeader('Vary') hit the same
// slot. The mock mirrors that - a case-sensitive object would let a real clobbering bug pass here.
function makeRes(existingHeaders: Record<string, string | string[]> = {}): Response {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(existingHeaders)) headers[name.toLowerCase()] = value;
  return {
    json: vi.fn(),
    end: vi.fn(),
    getHeader: vi.fn((name: string) => headers[name.toLowerCase()]),
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    __headers: headers,
  } as unknown as Response;
}

const headersOf = (res: Response) => (res as unknown as { __headers: Record<string, string> }).__headers;

// Padding long enough to push the serialized JSON past GZIP_THRESHOLD_BYTES while staying far
// under LARGE_RESPONSE_BYTES_THRESHOLD, so the two thresholds can be exercised independently.
const OVER_GZIP_THRESHOLD_PAYLOAD = { data: 'x'.repeat(GZIP_THRESHOLD_BYTES + 1024) };

describe('sendMaybeGzip', () => {
  beforeEach(() => {
    mockEmitMetrics.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends small responses uncompressed via res.json', () => {
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, { logs: [] });

    expect(res.json).toHaveBeenCalledWith({ logs: [] });
    expect(res.end).not.toHaveBeenCalled();
    expect(headersOf(res)['content-encoding']).toBeUndefined();
  });

  it('gzips responses over the threshold when the client accepts gzip, and the output round-trips', () => {
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).not.toHaveBeenCalled();
    expect(headersOf(res)['content-type']).toBe('application/json; charset=utf-8');
    expect(headersOf(res)['content-encoding']).toBe('gzip');
    expect(res.end).toHaveBeenCalledTimes(1);

    const compressed = (res.end as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
    expect(JSON.parse(gunzipSync(compressed).toString('utf8'))).toEqual(OVER_GZIP_THRESHOLD_PAYLOAD);
  });

  it('sets Vary: Accept-Encoding on both the compressed and uncompressed paths', () => {
    const compressedRes = makeRes();
    sendMaybeGzip(makeReq('gzip'), compressedRes, OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(headersOf(compressedRes)['vary']).toBe('Accept-Encoding');

    const plainRes = makeRes();
    sendMaybeGzip(makeReq('gzip'), plainRes, { logs: [] });
    expect(headersOf(plainRes)['vary']).toBe('Accept-Encoding');
  });

  it('appends to an existing Vary header instead of clobbering it', () => {
    const res = makeRes({ Vary: 'Origin' });

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(headersOf(res)['vary']).toBe('Origin, Accept-Encoding');
  });

  it('does not duplicate Accept-Encoding if it is already present in Vary', () => {
    const res = makeRes({ Vary: 'Accept-Encoding' });

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(headersOf(res)['vary']).toBe('Accept-Encoding');
  });

  it('matches an existing Vary token case-insensitively and across multiple tokens', () => {
    const res = makeRes({ Vary: 'origin, accept-encoding' });

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(headersOf(res)['vary']).toBe('origin, accept-encoding');
  });

  it('appends to an array-valued Vary header', () => {
    const res = makeRes({ Vary: ['Origin', 'Cookie'] });

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(headersOf(res)['vary']).toBe('Origin, Cookie, Accept-Encoding');
  });

  it('does not treat a longer header name containing "accept-encoding" as a duplicate', () => {
    const res = makeRes({ Vary: 'X-Accept-Encoding' });

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(headersOf(res)['vary']).toBe('X-Accept-Encoding, Accept-Encoding');
  });

  it('does not compress when Accept-Encoding omits gzip', () => {
    const res = makeRes();

    sendMaybeGzip(makeReq('br, deflate'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not compress when the Accept-Encoding header is absent entirely', () => {
    const res = makeRes();

    sendMaybeGzip(makeReq(), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not compress when the client explicitly disables gzip via q=0', () => {
    const res = makeRes();

    sendMaybeGzip(makeReq('gzip;q=0, deflate'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('still compresses for gzip;q=0.5 (only an explicit q=0 opts out)', () => {
    const res = makeRes();

    sendMaybeGzip(makeReq('gzip;q=0.5'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('respects the DISABLE_RESPONSE_GZIP kill-switch', () => {
    vi.stubEnv('DISABLE_RESPONSE_GZIP', 'true');
    const res = makeRes();

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('reports the exact uncompressed byte count, dimensioned by route, once past the large threshold', () => {
    const res = makeRes();
    const largePayload = { data: 'x'.repeat(LARGE_RESPONSE_BYTES_THRESHOLD + 1) };
    const expectedBytes = Buffer.byteLength(JSON.stringify(largePayload));

    sendMaybeGzip(makeReq('gzip'), res, largePayload);

    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    const [namespace, metrics] = mockEmitMetrics.mock.calls[0];
    expect(namespace).toBe('Lumina5/ApiResponse');
    expect(metrics).toEqual([
      {
        name: LARGE_API_RESPONSE_METRIC,
        value: expectedBytes,
        // query string stripped so the dimension stays bounded
        dimensions: { route: '/api/users/counterLogs', compressed: 'true' },
        unit: StandardUnit.Bytes,
      },
    ]);
  });

  it('additionally emits the dimensionless alarm metric when a large body ships uncompressed', () => {
    const res = makeRes();
    const largePayload = { data: 'x'.repeat(LARGE_RESPONSE_BYTES_THRESHOLD + 1) };
    const expectedBytes = Buffer.byteLength(JSON.stringify(largePayload));

    // no gzip in Accept-Encoding -> large body goes out raw, the only case that can still 502
    sendMaybeGzip(makeReq('br'), res, largePayload);

    const [, metrics] = mockEmitMetrics.mock.calls[0];
    expect(metrics).toHaveLength(2);
    expect(metrics).toContainEqual({
      name: LARGE_UNCOMPRESSED_API_RESPONSE_METRIC,
      value: expectedBytes,
      unit: StandardUnit.Bytes,
    });
    expect(metrics[0].dimensions).toEqual({ route: '/api/users/counterLogs', compressed: 'false' });
  });

  it('does not report to CloudWatch for responses below the large-response threshold', () => {
    const res = makeRes();

    sendMaybeGzip(makeReq('gzip'), res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(mockEmitMetrics).not.toHaveBeenCalled();
  });
});
