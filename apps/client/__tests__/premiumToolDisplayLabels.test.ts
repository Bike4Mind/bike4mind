import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the tool display label contribution (see `PremiumToolDisplayLabels`): labels reach the
 * tool chips verbatim, so the validator is the control on their shape. Runs the real script inside a
 * sandbox tree, as premiumWorkspaceCopyEntitlements.test.ts does.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumToolDisplayLabels.generated.ts';

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
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-toollabels-test-'));
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

describe('premium tool display labels', () => {
  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    expect(generate()).toContain('premiumToolDisplayLabels: PremiumToolDisplayLabels = {}');
  });

  it('emits declared labels without importing the overlay', () => {
    writeOverlay('alpha', { toolDisplayLabels: { alpha_run_job: 'Run Job', 'alpha.scan': 'Deep Scan' } });

    const generated = generate();

    expect(generated).toContain(`"alpha_run_job": "Run Job",`);
    expect(generated).toContain(`"alpha.scan": "Deep Scan",`);
    expect(generated).not.toContain('@bike4mind/premium-alpha');
  });

  it('merges labels across overlays and accepts an identical repeat', () => {
    writeOverlay('alpha', { toolDisplayLabels: { shared_tool: 'Shared' } });
    writeOverlay('beta', { toolDisplayLabels: { shared_tool: 'Shared', beta_tool: 'Beta Tool' } });

    const generated = generate();

    expect(generated.match(/"shared_tool"/g)).toHaveLength(1);
    expect(generated).toContain(`"beta_tool": "Beta Tool",`);
  });

  it('fails when two overlays name one tool differently, naming both', () => {
    writeOverlay('alpha', { toolDisplayLabels: { shared_tool: 'One' } });
    writeOverlay('beta', { toolDisplayLabels: { shared_tool: 'Two' } });

    expectRejected(/"shared_tool" differently in packages "@bike4mind\/premium-alpha" and "@bike4mind\/premium-beta"/);
  });

  it('rejects a non-object declaration', () => {
    writeOverlay('bad', { toolDisplayLabels: ['alpha_run_job'] });

    expectRejected(/invalid toolDisplayLabels from package "@bike4mind\/premium-bad"/);
  });

  it('rejects a tool id outside the safe charset', () => {
    writeOverlay('bad', { toolDisplayLabels: { 'x"]; process.exit(0); //': 'Label' } });

    expectRejected(/invalid toolDisplayLabels tool id/);
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['an untrimmed string', ' Padded'],
    ['a multi-line string', 'Two\nLines'],
    ['an over-long string', 'x'.repeat(65)],
  ])('rejects %s label', (_case, label) => {
    writeOverlay('bad', { toolDisplayLabels: { alpha_run_job: label } });

    expectRejected(/invalid toolDisplayLabels label for "alpha_run_job"/);
  });
});
