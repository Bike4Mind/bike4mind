import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';

// Build pieces both bundles of this package use: the Electron app (electron.vite.config.ts)
// and the headless host (vite.host.config.ts).

// Used when no B4M_DEFAULT_API_URL is supplied; a fork overrides it by setting that variable.
export const PRODUCTION_API_URL = 'https://app.bike4mind.com';

/**
 * Puts the tree-sitter wasm binaries beside the main bundle, in `wasm/`. The shell parser reads
 * them at runtime by file path, so a bundler that never sees an import for them would otherwise
 * leave a packaged app with a parser that cannot start.
 */
export function copyTreeSitterWasm(): Plugin {
  const require = createRequire(join(__dirname, 'package.json'));
  const assets = ['web-tree-sitter/tree-sitter.wasm', 'tree-sitter-bash/tree-sitter-bash.wasm'];
  return {
    name: 'copy-tree-sitter-wasm',
    writeBundle(options) {
      const target = join(options.dir ?? resolve(__dirname, 'out/main'), 'wasm');
      mkdirSync(target, { recursive: true });
      for (const asset of assets) copyFileSync(require.resolve(asset), join(target, asset.split('/').pop() as string));
    },
  };
}

/**
 * One of the brand values supplied at build time and never committed. Precedence is the
 * shell environment first - that is how CI injects them for the CLI today, and how a
 * packaging run injects them here - then a gitignored `.env`/`.env.local` in this
 * directory, which only exists so a local packaging run is one command rather than a long
 * prefix. Absent both, the value is empty.
 *
 * An empty shell value counts as unset for the backend, because CI passes an unset repository
 * variable through as ''. It does not for the others: an explicit '' is how the ad-hoc macOS
 * build in desktop-release.yml switches updates off.
 */
export function baked(
  mode: string,
  name: 'B4M_DEFAULT_API_URL' | 'B4M_UPDATE_FEED_URL' | 'B4M_UPDATE_PUBLIC_KEYS' | 'B4M_CURATED_MANIFEST_URL'
): string {
  const shell = process.env[name];
  if (shell !== undefined && (shell !== '' || name !== 'B4M_DEFAULT_API_URL')) return shell;
  // loadEnv lets a prefixed shell value override the file's even when that value is empty.
  delete process.env[name];
  try {
    return loadEnv(mode, __dirname, 'B4M_')[name] ?? '';
  } finally {
    if (shell !== undefined) process.env[name] = shell;
  }
}

/** The release-derived version an unpackaged run shows. Computed in every mode and unable to fail the build. */
export function devVersionInfo(): { version: string; basis: string } {
  try {
    const { readDevVersion } = createRequire(join(__dirname, 'package.json'))('./scripts/dev-version.cjs') as {
      readDevVersion(cwd: string): { version: string; basis: string };
    };
    return readDevVersion(__dirname);
  } catch {
    return { version: '', basis: '' };
  }
}
