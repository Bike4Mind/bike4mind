import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REGISTRATION_IMPORT = /^import '@client\/lib\/settings\/registerContributedSettings';$/m;
// Generated glue that runs extension code, as opposed to the data-only glue modules.
const EXTENSION_CODE_IMPORT =
  /from '[^']*premium-generated\/premium(AgentExtensions|LlmTools|WorkspaceSessionSettings|SystemPrompts|PartnerSignupHooks)\.generated'/;
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
  it('is imported by every server module that loads contributed extension code', () => {
    const loaders = [join(repoRoot, 'apps/client/server'), join(repoRoot, 'apps/workers/src')]
      .flatMap(sourceFiles)
      .filter(f => EXTENSION_CODE_IMPORT.test(readFileSync(f, 'utf8')));

    expect(loaders.length).toBeGreaterThan(0);
    const missing = loaders.filter(f => !REGISTRATION_IMPORT.test(readFileSync(f, 'utf8')));
    expect(missing.map(f => relative(repoRoot, f))).toEqual([]);
  });
});
