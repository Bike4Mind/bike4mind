import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Scripts that run only when launched directly. The helper is unit-tested on its own; this pins
// that each script goes through it and still starts when reached through a symlink.
const GUARDED_SCRIPTS = ['cleanupOldQuerySubscriptions.ts', 'src/seed-oauth-client.ts'];

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

    it('still starts cleanupOldQuerySubscriptions', () => {
      const result = spawnSync(
        process.execPath,
        [tsxCli, path.join(link, 'cleanupOldQuerySubscriptions.ts'), '--help'],
        {
          cwd: SCRIPTS_DIR,
          encoding: 'utf-8',
          timeout: 120_000,
        }
      );

      // --help is answered by the CLI's own yargs parser inside main(), so this proves the guard
      // fired without needing a database.
      expect(result.stdout).toContain('Delete documents older than N days');
    }, 130_000);

    it('still starts seed-oauth-client', () => {
      const result = spawnSync(process.execPath, [tsxCli, path.join(link, 'src', 'seed-oauth-client.ts')], {
        cwd: SCRIPTS_DIR,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...process.env, MONGODB_URI: '' },
      });

      expect(result.stderr).toContain('MONGODB_URI env var required');
      expect(result.status).toBe(1);
    }, 130_000);
  });
});
