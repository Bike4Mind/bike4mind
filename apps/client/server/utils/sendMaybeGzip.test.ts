import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { Request, Response } from 'express';

const mockEmitMetric = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

import {
  GZIP_THRESHOLD_BYTES,
  LARGE_API_RESPONSE_METRIC,
  LARGE_RESPONSE_BYTES_THRESHOLD,
  sendMaybeGzip,
} from '@server/utils/sendMaybeGzip';

function makeReq(acceptEncoding?: string): Request {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return {
    logger,
    url: '/api/users/counterLogs',
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  } as unknown as Request;
}

function makeRes(): Response {
  return { json: vi.fn(), setHeader: vi.fn(), end: vi.fn() } as unknown as Response;
}

// Padding string long enough to push the serialized JSON past GZIP_THRESHOLD_BYTES while staying
// far under LARGE_RESPONSE_BYTES_THRESHOLD, so the two thresholds can be exercised independently.
const OVER_GZIP_THRESHOLD_PAYLOAD = { data: 'x'.repeat(GZIP_THRESHOLD_BYTES + 1024) };

describe('sendMaybeGzip', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockEmitMetric.mockClear();
  });

  it('sends small responses uncompressed via res.json', () => {
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, { logs: [] });

    expect(res.json).toHaveBeenCalledWith({ logs: [] });
    expect(res.end).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('gzips responses over the threshold when the client accepts gzip, and the output round-trips', () => {
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Encoding', 'gzip');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Accept-Encoding');
    expect(res.end).toHaveBeenCalledTimes(1);

    const compressed = (res.end as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
    const decompressed = gunzipSync(compressed).toString('utf8');
    expect(JSON.parse(decompressed)).toEqual(OVER_GZIP_THRESHOLD_PAYLOAD);
  });

  it('does not compress when Accept-Encoding omits gzip', () => {
    const req = makeReq('br, deflate');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not compress when the client explicitly disables gzip via q=0', () => {
    const req = makeReq('gzip;q=0, deflate');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('still compresses for gzip;q=0.5 (only an explicit q=0 opts out)', () => {
    const req = makeReq('gzip;q=0.5');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('respects the DISABLE_RESPONSE_GZIP kill-switch', () => {
    vi.stubEnv('DISABLE_RESPONSE_GZIP', 'true');
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(res.json).toHaveBeenCalledWith(OVER_GZIP_THRESHOLD_PAYLOAD);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('emits a CloudWatch metric once the uncompressed body crosses the large-response threshold', () => {
    const req = makeReq('gzip');
    const res = makeRes();
    const largePayload = { data: 'x'.repeat(LARGE_RESPONSE_BYTES_THRESHOLD + 1) };

    sendMaybeGzip(req, res, largePayload);

    expect(mockEmitMetric).toHaveBeenCalledWith(
      'Lumina5/ApiResponse',
      LARGE_API_RESPONSE_METRIC,
      expect.any(Number),
      {},
      StandardUnit.Bytes
    );
  });

  it('does not emit the CloudWatch metric for responses below the large-response threshold', () => {
    const req = makeReq('gzip');
    const res = makeRes();

    sendMaybeGzip(req, res, OVER_GZIP_THRESHOLD_PAYLOAD);

    expect(mockEmitMetric).not.toHaveBeenCalled();
  });
});
