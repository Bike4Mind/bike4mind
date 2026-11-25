import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The data-subject registry imports the generated file statically, so it must exist (empty) with nothing mounted. */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'packages/server-utils/src/premium-generated/premiumDataSubjectRegistry.generated.ts';

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
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-datasubject-test-'));
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

describe('premium data subject registry', () => {
  it('emits the empty typed form when no overlay contributes', () => {
    const out = generate();
    expect(out).toContain(`import type { ContributedDataHolderRegistry } from '../dataSubject/types';`);
    expect(out).toContain('premiumDataSubjectRegistries: readonly ContributedDataHolderRegistry[] = [];');
  });

  it('imports each contributing overlay module and keeps one entry per package', () => {
    writeOverlay('alpha', { dataSubjectRegistryExport: '@bike4mind/premium-alpha/data-subject' });
    writeOverlay('beta', { dataSubjectRegistryExport: '@bike4mind/premium-beta/data-subject' });
    writeOverlay('gamma', {});
    const out = generate();
    expect(out).toContain(
      `import { dataSubjectRegistry as registry0 } from '../../../premium/alpha/src/data-subject';`
    );
    expect(out).toContain(`import { dataSubjectRegistry as registry1 } from '../../../premium/beta/src/data-subject';`);
    expect(out).toContain('= [\n  registry0,\n  registry1\n];');
    expect(out).not.toContain('gamma');
  });

  it('lists the model names an overlay source registers, contributing or not', () => {
    writeOverlay('alpha', { dataSubjectRegistryExport: '@bike4mind/premium-alpha/data-subject' });
    writeOverlay('gamma', {});
    const write = (dir: string, file: string, source: string) => {
      mkdirSync(join(sandbox, 'packages/premium', dir, 'src', ...file.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(sandbox, 'packages/premium', dir, 'src', file), source);
    };
    write('alpha', 'models/Note.ts', "export const Note = mongoose.model<INote>('AlphaNote', schema);\n");
    write(
      'gamma',
      'models/Log.ts',
      "export const Log =\n  mongoose.models.GammaLog ||\n  mongoose.model(\n    'GammaLog',\n    s\n  );\n"
    );
    write('gamma', 'models/Seen.ts', "const ModelName = 'GammaSeen';\nmongoose.model<ISeen>(ModelName, schema);\n");
    write('gamma', 'models/Log.test.ts', "mongoose.model('GammaTestOnly', s);\n");
    write('gamma', 'models/Old.ts', "// mongoose.model('GammaCommented', s);\n/* model('GammaBlock', s) */\n");
    const out = generate();
    expect(out).toContain('premiumDeclaredModelNames: readonly string[] = ["AlphaNote","GammaLog","GammaSeen"];');
  });

  it('emits an empty declared model list when no overlay is mounted', () => {
    expect(generate()).toContain('premiumDeclaredModelNames: readonly string[] = [];');
  });

  it('rejects a specifier that is not a module path', () => {
    writeOverlay('alpha', { dataSubjectRegistryExport: "x'; process.exit(1); '" });
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dataSubjectRegistryExport/);
  });
});
