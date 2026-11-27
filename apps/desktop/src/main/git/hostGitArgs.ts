import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * The timeout for a quick git read, given its `gitCommandEnv`: through wsl.exe (an env is set) it
 * can spend seconds starting a distro that is not running yet.
 */
export function quickGitTimeout(env: NodeJS.ProcessEnv | undefined): number {
  return env ? 10_000 : 2000;
}

/** Of `env`, only what wsl.exe passes into Linux: the variables WSLENV names for that direction. */
export function crossingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    wslEnvNames(env)
      .filter(name => env[name] !== undefined)
      .map(name => [name, env[name]])
  );
}

/** `submodule` marks an entry read from a checked-out submodule's config rather than the repository's own. */
export type ConfigEntry = { scope: string; key: string; value: string; submodule?: boolean };
export type ScopedConfigReader = (cwd: string) => Promise<ConfigEntry[]>;

const NETWORK_KEYS =
  '^(credential\\.(.*\\.)?helper|core\\.sshcommand|core\\.askpass|core\\.gitproxy|remote\\..+\\.(uploadpack|receivepack))$';

/** Repository settings that name a program git runs while it reads or writes work-tree files. */
const PROGRAM_KEYS =
  '^(filter\\..+\\.(clean|smudge|process|required)|diff\\..+\\.(textconv|command)|merge\\..+\\.driver)$';

/** `git config --show-scope --get-regexp pattern` in `directory`: [] when nothing matches, null when git could not answer. */
async function scopedConfig(
  directory: string,
  pattern: string,
  keepValueless: boolean,
  timeout?: number
): Promise<ConfigEntry[] | null> {
  const env = await gitCommandEnv(directory);
  const command = await gitCommand(directory, ['config', '--show-scope', '-z', '--get-regexp', pattern]);
  return new Promise(resolve => {
    // With no git there is no call to protect; the caller's own lookup reports it.
    if (!command) return resolve([]);
    const { file, args, cwd } = command;
    const limit = timeout ?? quickGitTimeout(env);
    execFile(file, args, { cwd, env, timeout: limit, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(error.code === 1 && !error.killed && !stdout && !stderr ? [] : null);
      // `-z` output is `scope\0key\nvalue\0` per entry; a key written without `=` has no value line.
      const fields = stdout.split('\0');
      const entries: ConfigEntry[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const newline = fields[i + 1].indexOf('\n');
        if (newline !== -1) {
          entries.push({
            scope: fields[i],
            key: fields[i + 1].slice(0, newline),
            value: fields[i + 1].slice(newline + 1),
          });
        } else if (keepValueless) entries.push({ scope: fields[i], key: fields[i + 1], value: '' });
      }
      resolve(entries);
    });
  });
}

const readScopedConfig: ScopedConfigReader = async directory =>
  (await scopedConfig(directory, NETWORK_KEYS, false)) ?? [];

// Apple Git reports its bundled config (which sets the osxkeychain helper) as `unknown`.
const TRUSTED_SCOPES = new Set(['system', 'global', 'unknown']);

export type ProgramConfigReader = (cwd: string) => Promise<ConfigEntry[] | null>;
// The call it guards fails without it, so it may take as long as that call would.
const PROGRAM_READ_TIMEOUT_MS = 20_000;
const MAX_SUBMODULE_DEPTH = 8;
const GITLINK = /^160000 [0-9a-f]+ \d\t(.+)$/s;

/**
 * Checked-out submodules of the repository holding `directory`, nested ones included, as paths this host reaches;
 * [] outside a work tree and null when git could not list them. git runs its own child in each one that `status`
 * and `diff` descend into, with that submodule's config.
 */
async function checkedOutSubmodules(directory: string, depth = 0): Promise<string[] | null> {
  if (depth > MAX_SUBMODULE_DEPTH) return null;
  const env = await gitCommandEnv(directory);
  // `:/` lists the whole repository from a subdirectory, printing paths relative to `directory`.
  const command = await gitCommand(directory, hostGitArgs(['ls-files', '-z', '-s', ':/'], directory));
  if (!command) return [];
  const { file, args, cwd } = command;
  const listing = await new Promise<string | null>(resolve =>
    execFile(
      file,
      args,
      { cwd, env, timeout: PROGRAM_READ_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        resolve(!error.killed && /not a git repository|must be run in a work tree/i.test(stderr) ? '' : null);
      }
    )
  );
  if (listing === null) return null;
  const paths = new Set<string>();
  for (const record of listing.split('\0')) {
    const path = GITLINK.exec(record)?.[1];
    if (path !== undefined) paths.add(join(directory, path));
  }
  const populated = await Promise.all(
    [...paths].map(path =>
      stat(join(path, '.git')).then(
        () => path,
        () => null
      )
    )
  );
  const found: string[] = [];
  for (const path of populated) {
    if (path === null) continue;
    const nested = await checkedOutSubmodules(path, depth + 1);
    if (nested === null) return null;
    found.push(path, ...nested);
  }
  return found;
}

const readProgramConfig: ProgramConfigReader = async directory => {
  const [own, submodules] = await Promise.all([
    scopedConfig(directory, PROGRAM_KEYS, true, PROGRAM_READ_TIMEOUT_MS),
    checkedOutSubmodules(directory),
  ]);
  if (own === null || submodules === null) return null;
  const configs = await Promise.all(
    submodules.map(path => scopedConfig(path, PROGRAM_KEYS, true, PROGRAM_READ_TIMEOUT_MS))
  );
  const entries = [...own];
  for (const config of configs) {
    if (config === null) return null;
    // Its system and global entries are the ones already read for the repository itself.
    for (const entry of config) if (!TRUSTED_SCOPES.has(entry.scope)) entries.push({ ...entry, submodule: true });
  }
  return entries;
};

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
  // git keeps the first value of these, so a later `-c` cannot pin them: the transport that runs one is refused instead.
  const repoSets = (pattern: RegExp) =>
    entries.some(entry => pattern.test(entry.key) && !TRUSTED_SCOPES.has(entry.scope));
  if (repoSets(/^remote\..+\.(uploadpack|receivepack)$/)) overrides.push('-c', 'protocol.file.allow=never');
  if (repoSets(/^core\.gitproxy$/)) overrides.push('-c', 'protocol.git.allow=never');
  overrides.push('-c', 'protocol.ext.allow=never', '-c', 'fetch.recurseSubmodules=false');
  return [...configArgsFor(cwd, platform), ...overrides, ...args];
}

/** Thrown when git cannot list the repository's driver programs, or sets one under a name `-c` cannot override. */
export class UnpinnableGitConfigError extends Error {
  constructor() {
    super('The repository config sets a filter, diff or merge program the app does not run.');
    this.name = 'UnpinnableGitConfigError';
  }
}

/** Thrown before a call that would write work-tree files while a filter only the repository config sets is emptied. */
export class RepositoryFilterError extends Error {
  constructor() {
    super(
      'This repository sets a file filter (such as git-crypt or Git LFS) only in its own git config. The app does not run it, so it will not check out files here. Use a terminal, or set the filter in your global git config.'
    );
    this.name = 'RepositoryFilterError';
  }
}

/** Subcommands that write work-tree files: with an emptied filter they would write the stored bytes, not the real file. */
const WRITES_FILES = new Set(['switch', 'checkout', 'reset', 'stash', 'merge', 'restore']);
const FILTER_PROGRAM = /^filter\..+\.(clean|smudge|process)$/;

const programReads = new Map<string, Promise<ConfigEntry[] | null>>();

/**
 * hostGitArgs for a call that may read or write work-tree files: every filter, diff and merge driver setting the
 * repository's own config, or a checked-out submodule's, makes is pinned to the user's system/global value, or
 * emptied, which git treats as no program. git hands `-c` settings down to the git it runs in a submodule. Throws
 * when git cannot list the settings or one cannot be pinned, and refuses a call that writes work-tree files while a
 * filter program only the repository itself sets is emptied.
 */
export async function hostWorkTreeGitArgs(
  args: readonly string[],
  cwd: string,
  readConfig: ProgramConfigReader = readProgramConfig,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  let read = readConfig === readProgramConfig ? programReads.get(cwd) : undefined;
  if (!read) {
    read = readConfig(cwd);
    if (readConfig === readProgramConfig) {
      // Shared only while in flight, so a status and a diff started together read once.
      programReads.set(cwd, read);
      const clear = () => programReads.delete(cwd);
      read.then(clear, clear);
    }
  }
  const entries = await read;
  if (entries === null) throw new UnpinnableGitConfigError();
  const writesFiles = args[0] === 'worktree' ? args[1] === 'add' : WRITES_FILES.has(args[0] ?? '');
  const pins: string[] = [];
  const untrusted = entries.filter(entry => !TRUSTED_SCOPES.has(entry.scope));
  for (const key of new Set(untrusted.map(entry => entry.key))) {
    if (key.includes('=') || key.includes('\n')) throw new UnpinnableGitConfigError();
    const trusted = entries.filter(entry => entry.key === key && TRUSTED_SCOPES.has(entry.scope)).at(-1)?.value;
    // A submodule's filter does not refuse the call: git writes that work tree only when it recurses into it.
    const ownFilter = FILTER_PROGRAM.test(key) && untrusted.some(entry => entry.key === key && !entry.submodule);
    if (trusted === undefined && writesFiles && ownFilter) throw new RepositoryFilterError();
    pins.push('-c', `${key}=${trusted ?? (key.endsWith('.required') ? 'false' : '')}`);
  }
  return [...configArgsFor(cwd, platform), ...pins, ...args];
}
