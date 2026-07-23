import type { NextApiRequest, NextApiResponse } from 'next';
import openapiSpec from '@public/openapi.json';

/**
 * GET /api/v1/openapi.json - the public, machine-readable API contract.
 *
 * Serves the committed spec (b4m-core/common generates it into
 * apps/client/public/openapi.json; CI drift-gates that file). The spec is
 * imported, not read from disk at runtime: under SST/OpenNext, files in
 * apps/client/public/ are served from S3/CloudFront and never reach this
 * Lambda, so a runtime fs read would be unreliable. The import bundles the
 * committed bytes into the handler, guaranteeing availability - same reasoning
 * as artifact-sandbox.ts serving inline HTML.
 *
 * The committed spec ships neutral placeholder server URLs (this is a public
 * repo - see document.ts), so at serve time we point the contract at the origin
 * the request actually arrived on: the prod placeholder is rewritten everywhere
 * it appears (contact URL + every `x-codeSamples`, all generated from the same
 * value), and `servers` is collapsed to that single real origin - dropping the
 * placeholder staging/local entries, which aren't reachable from here anyway. A
 * consumer fetching the live spec then gets working URLs for SDK codegen and
 * "try it". (The committed file keeps all three env entries for reference.)
 *
 * CORS is fully permissive: this publishes only the public contract (no
 * secrets), so any browser tool or SDK generator can fetch it cross-origin.
 * A raw Next handler (not baseApi) so the route needs no DB connection and
 * cannot 5xx on a Mongo outage.
 */

// Serialized once at module load; each request only swaps the placeholder host.
const SPEC_JSON = JSON.stringify(openapiSpec);
// The prod server URL from the committed spec. The same string is baked into
// the code samples and contact URL, so replacing it everywhere is sufficient.
const PLACEHOLDER_URL = (openapiSpec as { servers?: Array<{ url?: string }> }).servers?.[0]?.url ?? '';

// A valid HTTP authority is a hostname (optionally :port) or a bracketed IPv6
// literal - every character of which is in this set. A direct-to-origin request
// can carry an arbitrary Host, so anything outside the set is rejected below.
const HOST_CHARSET = /^[A-Za-z0-9.\-:[\]]+$/;

function specForRequest(req: NextApiRequest): string {
  const host = req.headers.host;
  if (!host || !PLACEHOLDER_URL) return SPEC_JSON;
  // Allowlist the Host charset before splicing it into the serialized JSON: a
  // malformed direct-to-origin Host (a quote/backslash/control char) would
  // otherwise break the JSON.parse below and 5xx. Same reasoning as the proto
  // allowlist - fall back to the committed spec rather than risk an injection.
  if (!HOST_CHARSET.test(host)) return SPEC_JSON;
  const xfProto = req.headers['x-forwarded-proto'];
  const rawProto = (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(',')[0]?.trim();
  // Allowlist the scheme: origin is spliced into the serialized JSON before it
  // is re-parsed below, so a proxy ever forwarding a quote/backslash/control
  // char in x-forwarded-proto would otherwise break JSON.parse and 5xx.
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const origin = `${proto}://${host}`;
  // Rewrite the prod placeholder wherever it is embedded (contact + code
  // samples), then advertise this one real origin as the only server.
  const spec = JSON.parse(SPEC_JSON.replaceAll(PLACEHOLDER_URL, origin)) as { servers?: unknown };
  spec.servers = [{ url: origin, description: 'Current deployment' }];
  return JSON.stringify(spec);
}

function setCorsHeaders(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end('Method Not Allowed');
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  // The body is rewritten per request origin, so shared caches must key on it.
  res.setHeader('Vary', 'Host, X-Forwarded-Proto');

  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(specForRequest(req));
}
