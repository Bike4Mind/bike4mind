// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Routes that hand out or change integration credentials (OAuth tokens, webhook secrets, GitHub App keys)
 * or approve a pending tool action on the user's behalf serve the signed-in app only. Every baseApi() call
 * in them must be `auth: 'jwtOnly'`, so an API key is never a credential there, whatever its scopes.
 * baseApi.ts skips the whole API-key chain under jwtOnly; this pins which routes use it.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route.
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

const SESSION_ONLY_ROUTES = [
  'mcp/confirm.ts',
  'mcp-servers/atlassian/refresh.ts',
  'mcp-servers/[id]/webhooks/github.ts',
  'mcp-servers/[id]/webhooks/github/secret.ts',
  'google-drive/token.ts',
  'organizations/[id]/api-keys/[keyId]/callback-secret.ts',
  'organizations/[id]/github/connection.ts',
  'organizations/[id]/github/rate-limit.ts',
  'organizations/[id]/github/repositories.ts',
  'organizations/[id]/github/rotate-key.ts',
  'organizations/[id]/github/rotate-pat.ts',
  'organizations/[id]/github/test.ts',
  'organizations/[id]/webhooks/github.ts',
  'organizations/[id]/webhooks/github/replay-dlq.ts',
  'organizations/[id]/webhooks/github/rotate-secret.ts',
  'organizations/[id]/webhooks/github/test.ts',
  'webhooks/jira/config/index.ts',
];

const BASE_API_CALL = /\bbaseApi\(([^)]*)\)/g;
const KEY_SHIMS = [/\bapiKeyAuth\(/, /\boptionalAuth\b/];

describe('session-only integration routes refuse API keys', () => {
  it.each(SESSION_ONLY_ROUTES)('%s', route => {
    const src = readFileSync(path.join(ROUTES_DIR, route), 'utf8');
    const calls = [...src.matchAll(BASE_API_CALL)].map(m => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/\bauth:\s*'jwtOnly'/);
    for (const shim of KEY_SHIMS) expect(src).not.toMatch(shim);
  });
});
