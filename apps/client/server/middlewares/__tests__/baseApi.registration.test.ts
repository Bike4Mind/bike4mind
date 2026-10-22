import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REGISTRATION_IMPORT = /^import '@client\/lib\/settings\/registerContributedSettings';$/m;
const repoRoot = join(__dirname, '..', '..', '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('node_modules'))
    .map(f => join(dir, f));
}

describe('baseApi contributed settings registration', () => {
  it('imports the registration module so every API route resolves contributed settings', () => {
    const source = readFileSync(join(__dirname, '..', 'baseApi.ts'), 'utf8');
    expect(source).toMatch(REGISTRATION_IMPORT);
  });

  // A process that runs extension code must also see the settings that extension contributes.
  it('is imported by every module that loads contributed agent extensions', () => {
    const loaders = [join(repoRoot, 'apps/client/server'), join(repoRoot, 'apps/workers/src')]
      .flatMap(sourceFiles)
      .filter(f => readFileSync(f, 'utf8').includes('premium-generated/premiumAgentExtensions.generated'));

    expect(loaders.length).toBeGreaterThan(0);
    const missing = loaders.filter(f => !REGISTRATION_IMPORT.test(readFileSync(f, 'utf8')));
    expect(missing.map(f => relative(repoRoot, f))).toEqual([]);
  });
});
