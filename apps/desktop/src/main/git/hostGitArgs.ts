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

export type ScopedConfigReader = (cwd: string, key: string) => Promise<Array<{ scope: string; value: string }>>;

const readScopedConfig: ScopedConfigReader = (cwd, key) =>
  new Promise(resolve => {
    execFile('git', ['config', '--show-scope', '--get-all', key], { cwd, timeout: 2000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const tab = line.indexOf('\t');
            return { scope: line.slice(0, tab), value: line.slice(tab + 1) };
          })
      );
    });
  });

const TRUSTED_SCOPES = new Set(['system', 'global']);

/**
 * Overrides for a git call that touches the network: the base set, plus credential, ssh and
 * askpass settings restricted to the user's own system/global config. Needs git 2.26+ for
 * `--show-scope`; on an older git the lookup fails and all three fall back to their defaults.
 */
export async function hostNetworkGitArgs(
  args: readonly string[],
  cwd: string,
  readConfig: ScopedConfigReader = readScopedConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const trusted = async (key: string): Promise<string[]> =>
    (await readConfig(cwd, key)).filter(entry => TRUSTED_SCOPES.has(entry.scope)).map(entry => entry.value);
  const [helpers, ssh, askPass] = await Promise.all([
    trusted('credential.helper'),
    env.GIT_SSH_COMMAND ? Promise.resolve([]) : trusted('core.sshCommand'),
    trusted('core.askPass'),
  ]);
  const overrides = ['-c', 'credential.helper=', ...helpers.flatMap(value => ['-c', `credential.helper=${value}`])];
  if (!env.GIT_SSH_COMMAND) overrides.push('-c', `core.sshCommand=${ssh.at(-1) ?? 'ssh'}`);
  overrides.push('-c', `core.askPass=${askPass.at(-1) ?? ''}`);
  return [...HOST_GIT_CONFIG_ARGS, ...overrides, ...args];
}
