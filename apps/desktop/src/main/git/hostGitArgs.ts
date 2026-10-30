import { execFile } from 'node:child_process';
const EMPTY_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Config overrides so a repo's own `.git/config` cannot run hooks or a file-system monitor on the host. */
export const HOST_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${EMPTY_HOOKS_PATH}`,
];

export function hostGitArgs(args: readonly string[]): string[] {
  return [...HOST_GIT_CONFIG_ARGS, ...args];
}

export type ConfigEntry = { scope: string; key: string; value: string };
export type ScopedConfigReader = (cwd: string) => Promise<ConfigEntry[]>;

const NETWORK_KEYS = '^(credential\\.(.*\\.)?helper|core\\.sshcommand|core\\.askpass)$';

const readScopedConfig: ScopedConfigReader = cwd =>
  new Promise(resolve => {
    execFile(
      'git',
      ['config', '--show-scope', '-z', '--get-regexp', NETWORK_KEYS],
      { cwd, timeout: 2000 },
      (error, stdout) => {
        if (error) return resolve([]);
        // `-z` output is `scope\0key\nvalue\0` per entry; a key written without `=` has no value line.
        const fields = stdout.split('\0');
        const entries: ConfigEntry[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const newline = fields[i + 1].indexOf('\n');
          if (newline === -1) continue;
          entries.push({
            scope: fields[i],
            key: fields[i + 1].slice(0, newline),
            value: fields[i + 1].slice(newline + 1),
          });
        }
        resolve(entries);
      }
    );
  });

// Apple Git reports its bundled config (which sets the osxkeychain helper) as `unknown`.
const TRUSTED_SCOPES = new Set(['system', 'global', 'unknown']);

/**
 * Overrides for a git call that touches the network: the base set, plus credential, ssh and
 * askpass settings restricted to the user's own system/global config. Needs git 2.26+ for
 * `--show-scope`; on an older git the lookup fails and no credential helper is kept.
 */
export async function hostNetworkGitArgs(
  args: readonly string[],
  cwd: string,
  readConfig: ScopedConfigReader = readScopedConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const entries = await readConfig(cwd);
  const trusted = entries.filter(entry => TRUSTED_SCOPES.has(entry.scope));
  const setByRepo = (key: string) => entries.some(entry => entry.key === key && !TRUSTED_SCOPES.has(entry.scope));
  const lastTrusted = (key: string) => trusted.filter(entry => entry.key === key).at(-1)?.value;

  // Plain and URL-scoped helper keys feed one list that an empty value resets, so after the
  // reset every trusted entry is replayed in config order. `-c` splits at the first `=`.
  const helpers = trusted.filter(entry => entry.key.startsWith('credential.') && !entry.key.includes('='));
  const overrides = ['-c', 'credential.helper=', ...helpers.flatMap(entry => ['-c', `${entry.key}=${entry.value}`])];
  // Pinned only when the repo sets the key, so GIT_SSH and SSH_ASKPASS still apply otherwise.
  if (!env.GIT_SSH_COMMAND && setByRepo('core.sshcommand')) {
    overrides.push('-c', `core.sshCommand=${lastTrusted('core.sshcommand') ?? 'ssh'}`);
  }
  if (!env.GIT_ASKPASS && setByRepo('core.askpass')) {
    overrides.push('-c', `core.askPass=${lastTrusted('core.askpass') ?? env.SSH_ASKPASS ?? ''}`);
  }
  return [...HOST_GIT_CONFIG_ARGS, ...overrides, ...args];
}
