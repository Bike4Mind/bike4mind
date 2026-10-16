import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the workspace denied-tools contribution: overlays declare tools a workspace denies, and
 * the generated table is applied at read time, so the validator is the control on its shape.
 * Runs the real script inside a sandbox tree, since its paths derive from its own location.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'server/premium-generated/premiumWorkspaceDeniedTools.generated.ts';

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
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-deniedtools-test-'));
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

describe('premium workspace denied tools', () => {
  it('emits the empty form when no overlay is present', () => {
    mkdirSync(join(sandbox, 'packages/premium'), { recursive: true });

    expect(generate()).toContain('premiumWorkspaceDeniedTools: PremiumWorkspaceDeniedTools = {}');
  });

  it('emits the empty form when an overlay declares none', () => {
    writeOverlay('silent', {});

    expect(generate()).toContain('premiumWorkspaceDeniedTools: PremiumWorkspaceDeniedTools = {}');
  });

  it('emits the declared table as data, without importing the overlay', () => {
    writeOverlay('alpha', { workspaceDeniedTools: { 'example-workspace': ['tool_a', 'tool_b'] } });

    const generated = generate();

    expect(generated).toContain(`"example-workspace": ["tool_a", "tool_b"]`);
    expect(generated).not.toContain('@bike4mind/premium-alpha');
  });

  it('merges across overlays and drops duplicates', () => {
    writeOverlay('alpha', { workspaceDeniedTools: { shared: ['tool_a', 'tool_b'] } });
    writeOverlay('beta', { workspaceDeniedTools: { shared: ['tool_b', 'tool_c'], other: ['tool_d'] } });

    const generated = generate();

    expect(generated).toContain(`"shared": ["tool_a", "tool_b", "tool_c"]`);
    expect(generated).toContain(`"other": ["tool_d"]`);
  });

  it('rejects a non-object declaration', () => {
    writeOverlay('malformed', { workspaceDeniedTools: ['tool_a'] });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('expected an object of workspace id -> tool names');
  });

  it('rejects a workspace id outside the safe charset', () => {
    writeOverlay('proto', { workspaceDeniedTools: JSON.parse('{"__proto__": ["tool_a"]}') });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceDeniedTools workspace id');
  });

  it('rejects a mixed-case workspace id, since surface ids match exactly', () => {
    writeOverlay('mixed', { workspaceDeniedTools: { 'Example-Workspace': ['tool_a'] } });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('must be lowercase');
  });

  it('rejects an entry that is not an array of tool names', () => {
    writeOverlay('loose', { workspaceDeniedTools: { space: 'tool_a' } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceDeniedTools: { space: [''] } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceDeniedTools: { space: [1] } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceDeniedTools: { space: [`x"]; process.exit(0); //`] } });
    const { status, stderr } = runCodegen();
    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceDeniedTools tools');
  });
});
