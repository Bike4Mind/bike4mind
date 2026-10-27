import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the agent-extension contribution: the workers' executor registry imports the generated
 * module statically, so it must exist (empty) with nothing mounted and aggregate every linked
 * package's export otherwise. Runs the real script inside a sandbox tree.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'packages/server-utils/src/premium-generated/premiumAgentExtensions.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

// The generator imports an overlay's declared export by relative path, so give each subpath the
// contributions name an `exports` entry pointing at src/<subpath>.ts.
function declaredExports(name: string, contributions: Record<string, unknown>) {
  const specifiers = Object.values(contributions).flatMap(value =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [value]
  );
  return Object.fromEntries(
    specifiers
      .filter((s): s is string => typeof s === 'string' && s.startsWith(`${name}/`))
      .map(s => [`.${s.slice(name.length)}`, `./src${s.slice(name.length)}.ts`])
  );
}

// Hydrates the overlay under packages/premium AND links it from apps/client's node_modules, the
// way a pnpm workspace link would, so the bare-specifier glue treats it as resolvable.
function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const name = `@bike4mind/premium-${dir}`;
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({ name, exports: declaredExports(name, contributions), b4mContributions: contributions })
  );
  const linkDir = join(clientRoot, 'node_modules', name);
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, 'package.json'), JSON.stringify({ name }));
}

function runCodegen() {
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when CI === 'true'.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(sandbox, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-agentext-test-'));
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
  rmSync(join(clientRoot, 'node_modules'), { recursive: true, force: true });
});

describe('premium agent extensions', () => {
  it('emits the empty typed form when no overlay is present', () => {
    const out = generate();
    expect(out).toContain(`import type { AgentExtensionContribution } from '@bike4mind/agents';`);
    expect(out).toContain('premiumAgentExtensions: AgentExtensionContribution[] = [];');
  });

  it('emits the empty form when no overlay declares the key', () => {
    writeOverlay('silent', {});
    expect(generate()).toContain('premiumAgentExtensions: AgentExtensionContribution[] = [];');
  });

  it('imports one contributor', () => {
    writeOverlay('alpha', { agentExtensionsExport: '@bike4mind/premium-alpha/agent-extensions' });
    const out = generate();
    expect(out).toContain(
      `import { agentExtensions as extensions0 } from '../../../premium/alpha/src/agent-extensions';`
    );
    expect(out).toContain('premiumAgentExtensions: AgentExtensionContribution[] = [\n  extensions0\n];');
  });

  it('aggregates two contributors as separate entries', () => {
    writeOverlay('alpha', { agentExtensionsExport: '@bike4mind/premium-alpha/agent-extensions' });
    writeOverlay('beta', { agentExtensionsExport: '@bike4mind/premium-beta/agent-extensions' });
    const out = generate();
    expect(out).toContain(`from '../../../premium/alpha/src/agent-extensions';`);
    expect(out).toContain(`from '../../../premium/beta/src/agent-extensions';`);
    expect(out).toContain('[\n  extensions0,\n  extensions1\n];');
  });

  it('rejects an export the overlay does not declare', () => {
    const overlayDir = join(sandbox, 'packages/premium/undeclared');
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(
      join(overlayDir, 'package.json'),
      JSON.stringify({
        name: '@bike4mind/premium-undeclared',
        b4mContributions: { agentExtensionsExport: '@bike4mind/premium-undeclared/agent-extensions' },
      })
    );
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot resolve agentExtensionsExport');
  });

  it('rejects a specifier that is not a module path', () => {
    writeOverlay('bad', { agentExtensionsExport: "x'; process.exit(1); '" });
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/agentExtensionsExport/);
  });
});
