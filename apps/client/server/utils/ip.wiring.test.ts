// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// The `app:` service block of a compose file: from its key to the next top-level service key.
function composeServiceBlock(file: string, service: string): string {
  const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const match = source.match(new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|\\n[a-z]|$)`));
  if (!match) throw new Error(`no "${service}" service in ${file}`);
  return match[1];
}

describe('self-host trusted-proxy wiring', () => {
  // Behind Caddy the socket peer is always Caddy's container IP, so dropping this setting would put
  // every visitor in one per-IP rate-limit bucket (see getClientIp in ip.ts).
  it('the bundled Caddy proxy trusts exactly one X-Forwarded-For hop by default', () => {
    expect(composeServiceBlock('compose.caddy.yaml', 'app')).toContain('TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}');
  });

  // A trusted hop is only safe while the app port is unreachable except through Caddy.
  it('the Caddy override keeps the app port bound to loopback', () => {
    expect(composeServiceBlock('compose.caddy.yaml', 'app')).toMatch(/- '127\.0\.0\.1:\$\{APP_HOST_PORT:-3000\}:3000'/);
  });
});
