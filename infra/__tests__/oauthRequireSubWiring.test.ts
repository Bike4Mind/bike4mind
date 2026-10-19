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
  // Pins the whole expression, so a PRODUCTION_STAGES default also fails: live federated
  // clients still use the identities path and would 401.
  it('forwards the var to the web server function, empty on every stage', () => {
    expect(web).toContain("OAUTH_AI_TOKEN_REQUIRE_SUB: process.env.OAUTH_AI_TOKEN_REQUIRE_SUB || '',");
  });

  it('is listed in the deploy contract', () => {
    expect(contract.deployEnv).toContain('OAUTH_AI_TOKEN_REQUIRE_SUB');
  });
});
