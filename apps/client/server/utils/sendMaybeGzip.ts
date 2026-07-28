import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitMetric } from '@server/utils/cloudwatch';

/**
 * Send a JSON response, gzip-compressing it in-handler when it's large enough to matter and the
 * client accepts gzip. Exists because AWS Lambda enforces a hard, non-configurable ~6MB
 * synchronous-invocation response-size limit that a plain res.json() can silently exceed - the
 * Lambda runtime rejects the response *after* the handler already returned, so the failure is a
 * bare 502 with nothing logged at the application level. Compressing in the handler means the
 * bytes crossing that limit are the compressed size, not the raw JSON.
 *
 * SAFE ONLY in OpenNext buffered (non-streaming) mode: the Lambda response-streaming wrapper
 * re-gzips based on Accept-Encoding and would overwrite our Content-Encoding header, causing
 * double-compression/corruption. Do not reuse this helper on a route that moves to streaming.
 *
 * Callers must `return sendMaybeGzip(...)` - it is the sole response sender for the route.
 */

/** Below Lambda's ~6MB hard limit with large headroom once gzip'd (repetitive JSON compresses ~85-90%). */
export const GZIP_THRESHOLD_BYTES = 512 * 1024;

/**
 * Uncompressed size at which we emit a CloudWatch metric. Next.js's own "API response ... exceeds
 * 4MB" warning measures the bytes passed to res.json(), so it goes silent once we res.end() a
 * pre-compressed buffer instead - this replaces that signal so uncompressed growth stays visible.
 */
export const LARGE_RESPONSE_BYTES_THRESHOLD = 5 * 1024 * 1024;

const API_RESPONSE_NAMESPACE = 'Lumina5/ApiResponse';
export const LARGE_API_RESPONSE_METRIC = 'LargeApiResponseBytes';

/** Rejects a bare `gzip` token but honors an explicit `gzip;q=0` (client opting out). */
function clientAcceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  if (!header) return false;
  if (!/\bgzip\b/i.test(header)) return false;
  return !/\bgzip\s*;\s*q=0(?:\.0+)?\s*(,|$)/i.test(header);
}

export function sendMaybeGzip(req: Request, res: Response, body: unknown): void {
  const serialized = Buffer.from(JSON.stringify(body));
  const uncompressedBytes = serialized.byteLength;

  req.logger.withMetadata({ uncompressedBytes, route: req.url }).info('api-response-size');

  if (uncompressedBytes >= LARGE_RESPONSE_BYTES_THRESHOLD) {
    void emitMetric(API_RESPONSE_NAMESPACE, LARGE_API_RESPONSE_METRIC, uncompressedBytes, {}, StandardUnit.Bytes);
  }

  const gzipDisabled = process.env.DISABLE_RESPONSE_GZIP === 'true';
  const shouldCompress =
    !gzipDisabled && uncompressedBytes >= GZIP_THRESHOLD_BYTES && clientAcceptsGzip(req.headers['accept-encoding']);

  if (!shouldCompress) {
    res.json(body);
    return;
  }

  // Compute the gzip buffer BEFORE touching headers: if gzipSync throws, no headers have been
  // sent yet, so errorHandler can still write a clean error response.
  const compressed = gzipSync(serialized);

  req.logger
    .withMetadata({
      uncompressedBytes,
      compressedBytes: compressed.byteLength,
      ratio: Number((compressed.byteLength / uncompressedBytes).toFixed(3)),
    })
    .info('api-response-gzipped');

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.end(compressed);
}
