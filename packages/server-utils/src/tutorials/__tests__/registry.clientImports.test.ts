import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tutorial content must reach the page only from what the server sends, overrides applied.
const PACKAGE_SRC = resolve(__dirname, '../..');
const APP_ROOT = resolve(PACKAGE_SRC, '../../../apps/client');
const CLIENT_ROOT = join(APP_ROOT, 'app');
const REGISTRY = join(PACKAGE_SRC, 'tutorials/registry.ts');
const PACKAGE_NAME = '@bike4mind/server-utils/';

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolveSpec(from: string, spec: string): string | undefined {
  const base = spec.startsWith('.')
    ? resolve(dirname(from), spec)
    : spec.startsWith(PACKAGE_NAME)
      ? join(PACKAGE_SRC, spec.slice(PACKAGE_NAME.length))
      : spec.startsWith('@client/') || spec.startsWith('@/')
        ? join(APP_ROOT, spec.slice(spec.indexOf('/') + 1))
        : undefined;
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    candidate => existsSync(candidate) && statSync(candidate).isFile()
  );
}

describe('client import graph', () => {
  it('finds the registry it guards', () => {
    expect(existsSync(REGISTRY)).toBe(true);
  });

  it('no file under apps/client/app imports the tutorials registry', () => {
    const offenders = sourceFiles(CLIENT_ROOT).filter(file =>
      [...readFileSync(file, 'utf8').matchAll(SPEC)].some(([, spec]) => resolveSpec(file, spec) === REGISTRY)
    );
    expect(offenders).toEqual([]);
  });

  it('no file under apps/client/app imports the server-only content or wiring', () => {
    const guarded = ['content.ts', 'core.ts', 'coreDeps.ts', 'coreDrafts.ts'].map(f =>
      join(PACKAGE_SRC, 'tutorials', f)
    );
    const draftsDir = join(PACKAGE_SRC, 'tutorials/drafts') + '/';
    const offenders = sourceFiles(CLIENT_ROOT).filter(file =>
      [...readFileSync(file, 'utf8').matchAll(SPEC)].some(([, spec]) => {
        const target = resolveSpec(file, spec) ?? '';
        return guarded.includes(target) || target.startsWith(draftsDir);
      })
    );
    expect(offenders).toEqual([]);
  });

  it('the resolver recognises every spelling of the registry path', () => {
    const probe = join(CLIENT_ROOT, 'probe.ts');
    for (const spec of [
      '@bike4mind/server-utils/tutorials/registry',
      '../../../packages/server-utils/src/tutorials/registry',
    ]) {
      expect(resolveSpec(probe, spec)).toBe(REGISTRY);
    }
  });
});
