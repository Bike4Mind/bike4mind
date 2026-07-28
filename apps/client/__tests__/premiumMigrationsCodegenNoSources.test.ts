import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression guard: the migrations codegen must not require overlay SOURCE files to
 * exist - only the paths their package.json declares.
 *
 * Dockerfile.chatcompletion builds in this order:
 *
 *   COPY --parents **\/package.json ./          <- package.json files only
 *   COPY apps/client/scripts ./apps/client/scripts
 *   RUN pnpm install --frozen-lockfile ...      <- postinstall runs the codegen HERE
 *   COPY . .                                    <- overlay sources arrive AFTER
 *
 * So at codegen time inside the image, every overlay's package.json is present and none
 * of its .ts source is. A generator that probes the filesystem to build an import path
 * therefore explodes in the image while working perfectly everywhere else. That is
 * exactly what happened on 2026-07-28: the first overlay to declare migrationsExport
 * turned every `Build & push server image(s)` step red with
 * "[codegen] cannot resolve migrationsExport", after the preceding fix had already made
 * the SST bundle work. The generated path is identical either way, so nothing is lost by
 * deriving it from package.json alone.
 *
 * Runs the real script against a throwaway tree rather than the repo, which also keeps it
 * clear of the codegen/test races the sibling premium* tests document.
 */

const SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');

let root: string;

function runCodegen(): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync('node', [join(root, 'apps/client/scripts/generate-premium-glue.mjs')], { cwd: root, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'premium-codegen-'));
  mkdirSync(join(root, 'apps/client/scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'apps/client/scripts/generate-premium-glue.mjs'));

  // An overlay that declares migrations, with its package.json present and its source
  // absent - the Docker install layer, reproduced exactly.
  const overlay = join(root, 'packages/premium/fixtureoverlay');
  mkdirSync(overlay, { recursive: true });
  writeFileSync(
    join(overlay, 'package.json'),
    JSON.stringify({
      name: '@bike4mind/premium-fixtureoverlay',
      exports: { './server/migrations': './src/server/migrations/index.ts' },
      b4mContributions: { migrationsExport: '@bike4mind/premium-fixtureoverlay/server/migrations' },
    }) + '\n'
  );
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('premium migrations codegen with overlay sources absent', () => {
  it('succeeds when only package.json is on disk', () => {
    const { ok, output } = runCodegen();
    expect(output).not.toContain('cannot resolve migrationsExport');
    expect(ok).toBe(true);
  });

  it('emits a relative import to the declared source path', () => {
    runCodegen();
    const generated = join(root, 'packages/scripts/migrate/migrations/premium.generated.ts');
    expect(existsSync(generated)).toBe(true);

    const content = readFileSync(generated, 'utf8');
    // Relative, extensionless, and pointing at the path package.json declared. A bare
    // @bike4mind/premium-* specifier here would not resolve from packages/scripts.
    expect(content).toContain(
      "import { migrations as migrations0 } from '../../../premium/fixtureoverlay/src/server/migrations/index';"
    );
    expect(content).not.toContain("from '@bike4mind/premium-fixtureoverlay");
  });
});
