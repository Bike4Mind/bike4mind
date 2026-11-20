import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { password } from '@inquirer/prompts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const CATALOG_PATH = 'catalog/model-hub/curated-v2.json';

/** True when the module at `moduleUrl` is the script node was started with, so tests can import it. */
export function isEntry(moduleUrl: string): boolean {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === moduleUrl;
}

/** A CLI path argument, relative to where `pnpm --filter` was run rather than to this package. */
export function cliPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.INIT_CWD ?? process.cwd(), value);
}

/** True when `file` (which need not exist yet) resolves inside `root`, following symlinks of its nearest parent. */
export function isInside(file: string, root: string): boolean {
  let parent = path.resolve(file);
  const rest: string[] = [];
  while (!existsSync(parent) && path.dirname(parent) !== parent) {
    rest.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const real = path.join(realpathSync(parent), ...rest);
  const relative = path.relative(realpathSync(root), real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** `CURATED_KEY_PASSPHRASE`, else a hidden prompt; `confirm` asks twice. */
export async function readPassphrase(env: NodeJS.ProcessEnv, confirm: boolean): Promise<string> {
  if (env.CURATED_KEY_PASSPHRASE) return env.CURATED_KEY_PASSPHRASE;
  const first = await password({ message: 'Key passphrase' });
  if (confirm && (await password({ message: 'Repeat the passphrase' })) !== first)
    throw new Error('the passphrases do not match');
  return first;
}
