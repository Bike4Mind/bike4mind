import type { NextApiRequest, NextApiResponse } from 'next';
import { AGENT_QUEST_MANIFEST } from '@bike4mind/common';

/**
 * GET /api/agent-quest/manifest - the machine-readable invitation to The Open Door.
 *
 * The quest is meant to be discovered by an agent rather than clicked through by
 * a person, so the manifest is the entry point: unauthenticated, permissively
 * CORS'd, and identical for every caller. The same document is served over MCP as
 * `b4m://agent-quest` (see the CLI's mcp/resources.ts), which is why the manifest
 * itself lives in @bike4mind/common rather than here.
 *
 * Every path inside the manifest is root-relative, so the body does not depend on
 * the request origin - no Host rewriting and no `Vary`, unlike
 * pages/api/v1/openapi.json.ts. That also keeps the document correct for
 * self-hosted deployments.
 *
 * A raw Next handler (not baseApi) so the route needs no DB connection and cannot
 * 5xx on a Mongo outage - same reasoning as openapi.json.ts.
 */

// Serialized once at module load: the document is a constant, so every response
// is byte-identical and there is nothing to rebuild per request.
const MANIFEST_JSON = JSON.stringify(AGENT_QUEST_MANIFEST);

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

  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(MANIFEST_JSON);
}
