import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the API-key scope contribution (see `PremiumApiKeyScope`): the catalog trusts the emitted
 * rows' shape, so the validator is the control on it. Runs the real script inside a sandbox tree, as
 * premiumEntitlementGrants.test.ts does.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumApiKeyScopes.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({ name: `@bike4mind/premium-${dir}`, b4mContributions: contributions })
  );
}

function runCodegen() {
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when CI === 'true'.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

function expectRejected(pattern: RegExp) {
  const result = runCodegen();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(pattern);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-apikeyscopes-test-'));
  clientRoot = join(sandbox, 'apps/client');
  script = join(clientRoot, 'scripts/generate-premium-glue.mjs');

  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, script);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(sandbox, 'packages/premium'), { recursive: true, force: true });
});

const emitted = (generated: string): unknown =>
  JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(';')));

const ACME_READ = {
  value: 'acme:read',
  label: 'Acme: Read',
  description: 'View acme widgets',
  endpoints: ['GET /api/acme/widgets', 'GET /api/acme/widgets/:id'],
  requiredEntitlement: 'acme:pro',
};

describe('premium API-key scopes', () => {
  it('emits the empty form when no overlay is present', () => {
    expect(generate()).toContain('premiumApiKeyScopes: readonly PremiumApiKeyScope[] = [];');
  });

  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    expect(emitted(generate())).toEqual([]);
  });

  it('emits declared rows without importing the overlay', () => {
    const { requiredEntitlement: _omitted, ...open } = { ...ACME_READ, value: 'acme:write' };
    writeOverlay('alpha', { apiKeyScopes: [ACME_READ, open] });

    const generated = generate();

    expect(generated).not.toContain('@bike4mind/premium-alpha');
    expect(emitted(generated)).toEqual([ACME_READ, open]);
  });

  it('collapses an identical row declared by two overlays', () => {
    writeOverlay('alpha', { apiKeyScopes: [ACME_READ] });
    writeOverlay('beta', { apiKeyScopes: [ACME_READ] });

    expect(emitted(generate())).toEqual([ACME_READ]);
  });

  it('fails the build when two overlays give one value different rows', () => {
    writeOverlay('alpha', { apiKeyScopes: [ACME_READ] });
    writeOverlay('beta', { apiKeyScopes: [{ ...ACME_READ, label: 'Other label' }] });

    expectRejected(/gives "acme:read" different rows/);
  });

  it.each([
    ['a non-array contribution', { value: 'acme:read' }, /expected an array/],
    ['a non-object row', ['acme:read'], /rows must be objects/],
    ['a value without an action', [{ ...ACME_READ, value: 'acme' }], /value "acme" must match/],
    ['an uppercase value', [{ ...ACME_READ, value: 'Acme:read' }], /must match/],
    ['a wildcard value', [{ ...ACME_READ, value: 'acme:*' }], /must match/],
    ['an over-long value', [{ ...ACME_READ, value: `acme:${'r'.repeat(96)}` }], /at most 100 characters/],
    ['the admin resource', [{ ...ACME_READ, value: 'admin:read' }], /reserved resource/],
    ['the cc-bridge resource', [{ ...ACME_READ, value: 'cc-bridge:read' }], /reserved resource/],
    ['the embed resource', [{ ...ACME_READ, value: 'embed:read' }], /reserved resource/],
    ['the datalake resource', [{ ...ACME_READ, value: 'datalake:read' }], /reserved resource/],
    ['an empty label', [{ ...ACME_READ, label: '' }], /label of "acme:read"/],
    ['an overlong label', [{ ...ACME_READ, label: 'x'.repeat(65) }], /label of "acme:read"/],
    ['a control character in the label', [{ ...ACME_READ, label: 'Acme\u0007' }], /label of "acme:read"/],
    ['a line break in the description', [{ ...ACME_READ, description: 'a\nb' }], /description of "acme:read"/],
    ['an overlong description', [{ ...ACME_READ, description: 'x'.repeat(201) }], /description of "acme:read"/],
    ['non-array endpoints', [{ ...ACME_READ, endpoints: 'GET /api/acme' }], /endpoints of "acme:read"/],
    ['a malformed endpoint', [{ ...ACME_READ, endpoints: ['/api/acme'] }], /endpoint "\/api\/acme"/],
    ['a malformed entitlement', [{ ...ACME_READ, requiredEntitlement: 'Acme Pro' }], /requiredEntitlement/],
    ['a confined flag', [{ ...ACME_READ, confined: true }], /unknown field "confined"/],
    ['an admin-only flag', [{ ...ACME_READ, adminOnly: true }], /unknown field "adminOnly"/],
  ])('rejects %s', (_name, apiKeyScopes, pattern) => {
    writeOverlay('alpha', { apiKeyScopes });

    expectRejected(pattern);
  });
});
