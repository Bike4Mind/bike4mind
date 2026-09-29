import type { NextApiRequest, NextApiResponse } from 'next';

// A valid HTTP authority is a hostname (optionally :port) or a bracketed IPv6
// literal; underscore is tolerated too (non-RFC, but seen in internal hostnames).
// Every allowed char is JSON-safe, so a value passing this test cannot break the
// JSON.parse below. A direct-to-origin request can carry an arbitrary Host, so
// anything outside the set is rejected (falls back to the unrewritten spec).
const HOST_CHARSET = /^[A-Za-z0-9._\-:[\]]+$/;

export type OpenApiSpecInput = { servers?: ReadonlyArray<{ url?: string }> };

// The type of the generated deploymentOpenApi.generated.ts. Both of its emitters
// (generate-premium-glue.mjs and common's generateDeployment.ts) import it by name
// rather than spelling the shape out, so the three cannot drift.
export type DeploymentOpenApiSpec = OpenApiSpecInput & Record<string, unknown>;

function specForRequest(req: NextApiRequest, specJson: string, placeholderUrl: string): string {
  const host = req.headers.host;
  if (!host || !placeholderUrl) return specJson;
  // Allowlist the Host charset before splicing it into the serialized JSON: a
  // malformed direct-to-origin Host (a quote/backslash/control char) would
  // otherwise break the JSON.parse below and 5xx. Same reasoning as the proto
  // allowlist - fall back to the unrewritten spec rather than risk an injection.
  if (!HOST_CHARSET.test(host)) return specJson;
  const xfProto = req.headers['x-forwarded-proto'];
  const rawProto = (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(',')[0]?.trim();
  // Allowlist the scheme: origin is spliced into the serialized JSON before it
  // is re-parsed below, so a proxy ever forwarding a quote/backslash/control
  // char in x-forwarded-proto would otherwise break JSON.parse and 5xx.
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const origin = `${proto}://${host}`;
  // Rewrite the prod placeholder wherever it is embedded (contact + code
  // samples), then advertise this one real origin as the only server.
  const spec = JSON.parse(specJson.replaceAll(placeholderUrl, origin)) as { servers?: unknown };
  spec.servers = [{ url: origin, description: 'Current deployment' }];
  return JSON.stringify(spec);
}

function setCorsHeaders(res: NextApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * A raw Next handler (not baseApi) serving an OpenAPI document: the route needs
 * no DB connection and cannot 5xx on a Mongo outage. The document ships neutral
 * placeholder server URLs (see b4m-core/common/src/openapi/document.ts), so each
 * response points it at the origin the request arrived on: the prod placeholder
 * is rewritten everywhere it appears (contact URL + every `x-codeSamples`), and
 * `servers` collapses to that one real origin.
 *
 * CORS is fully permissive: a spec carries no secrets, so any browser tool or SDK
 * generator can fetch it cross-origin.
 */
export function createOpenApiSpecHandler(spec: OpenApiSpecInput) {
  // Serialized once; each request only swaps the placeholder host. The prod
  // server URL is also baked into the code samples and contact URL, so
  // replacing it everywhere is sufficient.
  const specJson = JSON.stringify(spec);
  const placeholderUrl = spec.servers?.[0]?.url ?? '';

  return function handler(req: NextApiRequest, res: NextApiResponse) {
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
    return res.status(200).send(specForRequest(req, specJson, placeholderUrl));
  };
}
