import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitMetrics } from '@server/utils/cloudwatch';

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
 * Uncompressed size at which we report to CloudWatch. Next.js's own "API response ... exceeds
 * 4MB" warning measures the bytes passed to res.json(), so it goes silent once we res.end() a
 * pre-compressed buffer instead - this replaces that signal so uncompressed growth stays visible.
 *
 * Only the UNcompressed path is actually at risk of the 502: OpenNext base64-encodes a body only
 * when Content-Encoding is set (`isBase64Encoded = isBinaryContentType(...) || !!content-encoding`),
 * and application/json is not a binary type, so an uncompressed JSON body ships as a plain string
 * against the full ~6MB ceiling while a gzipped one is ~10% of that even after base64.
 */
export const LARGE_RESPONSE_BYTES_THRESHOLD = 5 * 1024 * 1024;

const API_RESPONSE_NAMESPACE = 'Lumina5/ApiResponse';

/** Diagnostic, dimensioned by route + whether we compressed. Not the alarm target. */
export const LARGE_API_RESPONSE_METRIC = 'LargeApiResponseBytes';

/**
 * Alarm target: emitted ONLY when a large body went out uncompressed, which is the sole case that
 * can still 502. Dimensionless on purpose so one alarm covers every route (a CloudWatch alarm must
 * match a metric's full dimension set, so it cannot watch the dimensioned metric above generically).
 */
export const LARGE_UNCOMPRESSED_API_RESPONSE_METRIC = 'LargeUncompressedApiResponseBytes';

/** Rejects a bare `gzip` token but honors an explicit `gzip;q=0` (client opting out). */
function clientAcceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  if (!header) return false;
  if (!/\bgzip\b/i.test(header)) return false;
  return !/\bgzip\s*;\s*q=0(?:\.0+)?\s*(,|$)/i.test(header);
}

/** Append to Vary rather than overwrite, so a caller's own Vary (e.g. Origin on a CORS route) survives. */
function appendVary(res: Response, value: string): void {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', value);
    return;
  }
  const current = Array.isArray(existing) ? existing.join(', ') : String(existing);
  if (current.split(',').some(token => token.trim().toLowerCase() === value.toLowerCase())) return;
  res.setHeader('Vary', `${current}, ${value}`);
}

export function sendMaybeGzip(req: Request, res: Response, body: unknown): void {
  const serialized = Buffer.from(JSON.stringify(body));
  const uncompressedBytes = serialized.byteLength;

  const gzipDisabled = process.env.DISABLE_RESPONSE_GZIP === 'true';
  const shouldCompress =
    !gzipDisabled && uncompressedBytes >= GZIP_THRESHOLD_BYTES && clientAcceptsGzip(req.headers['accept-encoding']);

  // Pathname only: the query string would make the metric dimension unbounded. A route with path
  // params (/api/x/[id]) would still be high-cardinality here - give it a static label first.
  const route = (req.url ?? '').split('?')[0];

  req.logger.withMetadata({ uncompressedBytes, route, compressed: shouldCompress }).info('api-response-size');

  if (uncompressedBytes >= LARGE_RESPONSE_BYTES_THRESHOLD) {
    void emitMetrics(API_RESPONSE_NAMESPACE, [
      {
        name: LARGE_API_RESPONSE_METRIC,
        value: uncompressedBytes,
        dimensions: { route, compressed: String(shouldCompress) },
        unit: StandardUnit.Bytes,
      },
      ...(shouldCompress
        ? []
        : [
            {
              name: LARGE_UNCOMPRESSED_API_RESPONSE_METRIC,
              value: uncompressedBytes,
              unit: StandardUnit.Bytes,
            },
          ]),
    ]);
  }

  // The response body differs by Accept-Encoding on BOTH paths, so Vary belongs on both.
  appendVary(res, 'Accept-Encoding');

  if (!shouldCompress) {
    res.json(body);
    return;
  }

  // Compute the gzip buffer BEFORE setting Content-Encoding or ending the response: if gzipSync
  // throws, nothing has been flushed and no encoding header is set, so errorHandler can still
  // write a clean error response.
  const compressed = gzipSync(serialized);

  req.logger
    .withMetadata({
      uncompressedBytes,
      compressedBytes: compressed.byteLength,
      ratio: Number((compressed.byteLength / uncompressedBytes).toFixed(3)),
    })
    .info('api-response-gzipped');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Encoding', 'gzip');
  res.end(compressed);
}
