import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every CLI that runs only when launched directly. The helper is unit-tested on its own; this pins
// that each script goes through it.
const GUARDED_SCRIPTS = [
  'cleanupOldQuerySubscriptions.ts',
  'src/seed-oauth-client.ts',
  'help/build-help-index.ts',
  'help/bundle-help-content.ts',
  'help/help-coverage-report.ts',
  'help/validate-help-content.ts',
  'help/vectorize-help-content.ts',
];

interface SymlinkLaunch {
  name: string;
  script: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  // Only asserted when set: the validator's exit code depends on the current docs corpus.
  expectedStatus?: number;
  stdoutContains?: string;
  stderrContains?: string;
}

// One launch per probe that answers without a database or network. cleanupOldQuerySubscriptions is
// answered by its own yargs parser inside main(), seed-oauth-client by its first env check, and the
// validator prints its banner before any validation runs.
const SYMLINK_LAUNCHES: SymlinkLaunch[] = [
  {
    name: 'cleanupOldQuerySubscriptions',
    script: 'cleanupOldQuerySubscriptions.ts',
    args: ['--help'],
    expectedStatus: 0,
    stdoutContains: 'Delete documents older than N days',
  },
  {
    name: 'seed-oauth-client',
    script: 'src/seed-oauth-client.ts',
    env: { MONGODB_URI: '' },
    expectedStatus: 1,
    stderrContains: 'MONGODB_URI env var required',
  },
  {
    name: 'validate-help-content',
    script: 'help/validate-help-content.ts',
    stdoutContains: 'Validating help content...',
  },
];

describe('scripts CLI entry guards', () => {
  it.each(GUARDED_SCRIPTS)('%s gates its CLI body on isDirectInvocation', file => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf-8');
    expect(source).toContain('if (isDirectInvocation(import.meta.url))');
    expect(source).not.toContain('process.argv[1]');
  });

  describe('launched through a symlinked directory', () => {
    let tmp: string;
    let link: string;
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-entry-guard-'));
      link = path.join(tmp, 'scripts-link');
      fs.symlinkSync(SCRIPTS_DIR, link);
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it.each(SYMLINK_LAUNCHES)(
      'still starts $name',
      ({ script, args = [], env, expectedStatus, stdoutContains, stderrContains }) => {
        const result = spawnSync(process.execPath, [tsxCli, path.join(link, script), ...args], {
          cwd: SCRIPTS_DIR,
          encoding: 'utf-8',
          timeout: 120_000,
          env: { ...process.env, ...env },
        });

        // A spawn failure (timeout, crash) would otherwise surface as an empty-string mismatch below.
        expect(result.error).toBeUndefined();
        if (expectedStatus !== undefined) expect(result.status, result.stderr).toBe(expectedStatus);
        if (stdoutContains) expect(result.stdout).toContain(stdoutContains);
        if (stderrContains) expect(result.stderr).toContain(stderrContains);
      },
      130_000
    );
  });
});
