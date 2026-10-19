/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// infra/*.ts only loads inside `sst`, so these assertions read the sources as text.
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const web = read('infra/web.ts');
const contract = JSON.parse(read('infra/deploy-contract.json')) as { deployEnv: string[] };

describe('OAUTH_AI_TOKEN_REQUIRE_SUB wiring', () => {
  it('forwards the var to the web server function, empty by default', () => {
    expect(web).toContain("OAUTH_AI_TOKEN_REQUIRE_SUB: process.env.OAUTH_AI_TOKEN_REQUIRE_SUB || '',");
  });

  // Live federated clients still use the identities path; a production default would 401 them.
  it('has no stage-based default', () => {
    const line = web.match(/^\s*OAUTH_AI_TOKEN_REQUIRE_SUB:.*$/m)?.[0] ?? '';
    expect(line).not.toBe('');
    expect(line).not.toContain('PRODUCTION_STAGES');
    expect(line).not.toContain('$app.stage');
  });

  it('is listed in the deploy contract', () => {
    expect(contract.deployEnv).toContain('OAUTH_AI_TOKEN_REQUIRE_SUB');
  });
});
