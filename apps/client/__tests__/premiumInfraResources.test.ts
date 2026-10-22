import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real codegen in a sandbox tree (its paths derive from its own location) and
// checks the infra-resource glue: one literal, written to the deploy side and the runtime
// side alike, with or without an overlay, linked or not.

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const TARGETS = [
  'infra/premium-generated/infraResources.generated.ts',
  'packages/server-utils/src/premium-generated/infraResources.generated.ts',
];

let sandbox: string;

function runCodegen() {
  const script = join(sandbox, 'apps/client/scripts/generate-premium-glue.mjs');
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function readTargets() {
  return TARGETS.map(t => readFileSync(join(sandbox, t), 'utf8'));
}

function writeOverlay(infraResources: unknown) {
  const dir = join(sandbox, 'packages/premium/fakeoverlay');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@bike4mind/premium-fakeoverlay', b4mContributions: { infraResources } })
  );
}

const ROTATION = {
  secret: 'EXAMPLE_API_TOKEN',
  description: 'Example token',
  rotationIntervalDays: 90,
  isAutomatic: false,
  rotationProcess: 'Rotate upstream, then sst secret set',
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'infra-fixture-'));
  mkdirSync(join(sandbox, 'apps/client/scripts'), { recursive: true });
  mkdirSync(join(sandbox, 'apps/client/pages/api'), { recursive: true });
  cpSync(REAL_SCRIPT, join(sandbox, 'apps/client/scripts/generate-premium-glue.mjs'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('infra resource glue', () => {
  it('emits empty lists to both targets with no overlay', () => {
    expect(runCodegen().status).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(infra).toContain('"secrets": []');
    expect(infra).toContain('"rotations": []');
  });

  it('emits the same declared data to both targets, even for an unlinked overlay', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN', env: true }], rotations: [ROTATION] });
    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(infra).toContain('"name": "EXAMPLE_API_TOKEN"');
    expect(infra).toContain('"env": true');
    expect(infra).toContain('"rotationIntervalDays": 90');
    // Data only: the overlay package itself is never imported.
    expect(infra).not.toContain('premium-fakeoverlay');
  });

  it('drops fields it does not know rather than copying them into the literal', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN', extra: "'); evil();" }] });
    expect(runCodegen().status).toBe(0);
    expect(readTargets()[0]).not.toContain('evil');
  });

  it.each([
    ['a non-object', 'nope'],
    ['a non-array secrets list', { secrets: {} }],
    ['a non-string secret name', { secrets: [{ name: 1 }] }],
    ['a non-boolean env flag', { secrets: [{ name: 'A', env: 'yes' }] }],
    ['a non-positive rotation interval', { rotations: [{ ...ROTATION, rotationIntervalDays: 0 }] }],
  ])('fails codegen on %s', (_label, value) => {
    writeOverlay(value);
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('b4mContributions.infraResources');
  });

  it('lists every core resource name infra/ declares', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(
      join(sandbox, 'infra/secrets.ts'),
      "export const secrets = {\n  A: new sst.Secret('CORE_A', 'x'),\n  B: new sst.Secret(\n    'CORE_B',\n    'y'\n  ),\n};\n"
    );
    writeFileSync(join(sandbox, 'infra/web.ts'), "export const web = new sst.aws.Nextjs('Web', {});\n");
    expect(runCodegen().status).toBe(0);
    expect(readTargets()[1]).toContain('coreResourceNames: readonly string[] | null = ["App","CORE_A","CORE_B","Web"]');
  });

  it('emits null core names without infra/, so the runtime registers nothing', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN' }] });
    expect(runCodegen().status).toBe(0);
    expect(readTargets()[1]).toContain('coreResourceNames: readonly string[] | null = null');
  });

  it('leaves unchanged files alone on a second run', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN' }] });
    expect(runCodegen().status).toBe(0);
    const second = runCodegen();
    for (const target of TARGETS) expect(second.stdout).toContain(`unchanged ${target}`);
  });
});
