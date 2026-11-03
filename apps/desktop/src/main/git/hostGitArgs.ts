import { execFile } from 'node:child_process';
import { hostProgram } from '../chat/tools/userPath';
import { toLinuxArgument, wslCommand, wslCommandEnv, wslEnvNames, wslLocation } from '../wsl/wslPath';
const EMPTY_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

function configArgs(emptyHooksPath: string): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${emptyHooksPath}`];
}

/** Config overrides so a repo's own `.git/config` cannot run hooks or a file-system monitor on the host. */
export const HOST_GIT_CONFIG_ARGS: readonly string[] = configArgs(EMPTY_HOOKS_PATH);

/** The overrides for git run in `directory`: a WSL folder gets Linux git, which needs Linux's null device. */
export function configArgsFor(
  directory: string | undefined,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  return directory && wslLocation(directory, platform) ? configArgs('/dev/null') : HOST_GIT_CONFIG_ARGS;
}

export function hostGitArgs(
  args: readonly string[],
  directory?: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return [...configArgsFor(directory, platform), ...args];
}

/** `git args...` run in `directory`: Linux git through wsl.exe for a WSL folder, the host's git otherwise (null if none). */
export async function gitCommand(
  directory: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): Promise<{ file: string; args: string[]; cwd?: string } | null> {
  const location = wslLocation(directory, platform);
  if (location) return wslCommand(location, 'git', args);
  const git = await hostProgram('git');
  return git ? { file: git, args: [...args], cwd: directory } : null;
}

/** A path argument for git run in `directory`: Linux git in a WSL folder is given the Linux path. */
export function gitArgumentPath(directory: string, path: string, platform: NodeJS.Platform = process.platform): string {
  const location = wslLocation(directory, platform);
  return location ? toLinuxArgument(location, path) : path;
}

/** The env for a `gitCommand` in `directory`; undefined keeps this process's own. */
export async function gitCommandEnv(
  directory: string,
  platform: NodeJS.Platform = process.platform
): Promise<NodeJS.ProcessEnv | undefined> {
  const location = wslLocation(directory, platform);
  // The distro user's PATH, so a credential helper such as `gh` resolves as it does in their shell.
  return location ? wslCommandEnv(process.env, location.distro) : undefined;
}

/** Of `env`, only what wsl.exe passes into Linux: the variables WSLENV names for that direction. */
export function crossingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    wslEnvNames(env)
      .filter(name => env[name] !== undefined)
      .map(name => [name, env[name]])
  );
}

export type ConfigEntry = { scope: string; key: string; value: string };
export type ScopedConfigReader = (cwd: string) => Promise<ConfigEntry[]>;

const NETWORK_KEYS = '^(credential\\.(.*\\.)?helper|core\\.sshcommand|core\\.askpass)$';

const readScopedConfig: ScopedConfigReader = async directory => {
  const env = await gitCommandEnv(directory);
  const command = await gitCommand(directory, ['config', '--show-scope', '-z', '--get-regexp', NETWORK_KEYS]);
  // wsl.exe can spend seconds starting a distro that is not running yet.
  const timeout = env ? 10_000 : 2000;
  return new Promise(resolve => {
    if (!command) return resolve([]);
    execFile(command.file, command.args, { cwd: command.cwd, env, timeout, windowsHide: true }, (error, stdout) => {
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
    });
  });
};

// Apple Git reports its bundled config (which sets the osxkeychain helper) as `unknown`.
const TRUSTED_SCOPES = new Set(['system', 'global', 'unknown']);

/**
 * Overrides for a git call that touches the network: the base set, plus credential, ssh and
 * askpass settings restricted to the user's own system/global config. Needs git 2.26+ for
 * `--show-scope`; on an older git the lookup fails and no credential helper is kept.
 *
 * `env` is this process's environment; for a WSL folder only what crosses into Linux counts.
 */
export async function hostNetworkGitArgs(
  args: readonly string[],
  cwd: string,
  readConfig: ScopedConfigReader = readScopedConfig,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  const env = wslLocation(cwd, platform) ? crossingEnv(hostEnv) : hostEnv;
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
  return [...configArgsFor(cwd, platform), ...overrides, ...args];
}
