import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HELP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every help CLI that runs only when launched directly. The helper is unit-tested on its own;
// this pins that each script actually goes through it.
const GUARDED_SCRIPTS = [
  'bundle-help-content.ts',
  'validate-help-content.ts',
  'build-help-index.ts',
  'help-coverage-report.ts',
  'vectorize-help-content.ts',
];

describe('help CLI entry guards', () => {
  it.each(GUARDED_SCRIPTS)('%s gates its CLI body on isDirectInvocation', file => {
    const source = fs.readFileSync(path.join(HELP_DIR, file), 'utf-8');
    expect(source).toContain('if (isDirectInvocation(import.meta.url))');
    expect(source).not.toContain('process.argv[1]');
  });

  describe('launched through a symlinked directory', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'help-entry-guard-'));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('still starts the validator CLI', () => {
      const link = path.join(tmp, 'help-link');
      fs.symlinkSync(HELP_DIR, link);
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

      const result = spawnSync(process.execPath, [tsxCli, path.join(link, 'validate-help-content.ts')], {
        cwd: path.resolve(HELP_DIR, '..'),
        encoding: 'utf-8',
        timeout: 120_000,
      });

      // The banner is printed before any validation runs, so this proves the guard fired without
      // tying the test to whether the current docs corpus is clean.
      expect(result.stdout).toContain('Validating help content...');
    }, 130_000);
  });
});
