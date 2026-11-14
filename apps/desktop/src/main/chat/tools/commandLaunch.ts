import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { COMMAND_TAG_ENV } from './commandTree';
import { resolveGitBash } from './gitBash';
import { wslCommand, wslCommandEnv, wslEnvNames, wslLocation } from '../../wsl/wslPath';
import { resolveUserPath } from './userPath';
import { sandboxAvailable, sandboxCommand, type SandboxedCommand } from './sandbox';

/**
 * Flip to true to confine shell commands to the granted roots again (macOS Seatbelt, see
 * sandbox.ts). Off because a confined command cannot reach the keychain, git credentials, `gh`
 * auth or a worktree's gitdir outside the roots; the approval modes are the safety layer.
 */
export const SANDBOX_SHELL_COMMANDS = false;

export const COMMAND_ENV = 'B4M_DESKTOP_COMMAND';

/**
 * Git Bash's MSYS runtime re-parses the Windows command line, so the command travels in the environment and
 * the argv stays fixed. Un-exported rather than unset, so `eval` gets the command text alone and errors quote it.
 */
export const WINDOWS_COMMAND_ARGS: readonly string[] = ['-c', `export -n ${COMMAND_ENV}; eval "$${COMMAND_ENV}"`];

export async function launchCommand(
  command: string,
  roots: readonly string[],
  protectedPaths: readonly string[],
  cwd: string
): Promise<SandboxedCommand> {
  if (SANDBOX_SHELL_COMMANDS) {
    if (!sandboxAvailable()) {
      throw new Error('Commands cannot be run on this machine: the macOS sandbox is unavailable.');
    }
    return sandboxCommand(command, roots, protectedPaths);
  }
  const wsl = wslLocation(cwd);
  if (wsl) {
    // The distro's own bash, so the command gets Linux git, hooks, node_modules and toolchain.
    const enter = wslCommand(wsl, 'bash', []);
    return {
      executable: enter.file,
      args: [...enter.args, '-c', command],
      processTag: randomUUID(),
      wslDistro: wsl.distro,
      cleanup: async () => undefined,
    };
  }
  if (process.platform === 'win32') {
    return {
      executable: await resolveGitBash(),
      args: [...WINDOWS_COMMAND_ARGS],
      env: { [COMMAND_ENV]: command },
      processTag: randomUUID(),
      cleanup: async () => undefined,
    };
  }
  return { executable: '/bin/bash', args: ['-c', command], cleanup: async () => undefined };
}

/** A detached Windows child has no console, and wsl.exe without one exits -1 or drops the output; a WSL command is found by its tag instead. */
export const spawnsDetached = (launch: Pick<SandboxedCommand, 'wslDistro'>): boolean => !launch.wslDistro;

/**
 * What a failed spawn in `cwd` reports. Node blames the shell with ENOENT when it is `cwd` that is missing; a WSL
 * folder is left unchecked, since a stat of one can block while the distro starts.
 */
export function spawnFailure(
  error: NodeJS.ErrnoException,
  cwd: string,
  launch: Pick<SandboxedCommand, 'wslDistro'>
): Error {
  if (error.code !== 'ENOENT' || launch.wslDistro || existsSync(cwd)) return error;
  return new Error(
    `The working folder ${cwd} no longer exists. It may have been moved, renamed or deleted, so the command was not run.`,
    { cause: error }
  );
}

/**
 * `env` with `safe.bareRepository=explicit` appended to git's GIT_CONFIG_COUNT entries and to a GIT_CONFIG_PARAMETERS
 * that is set (git reads it last), and the names it set. Command-line scope no repository's config can override.
 */
export function withExplicitBareRepositories(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; names: string[] } {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const next = Number.isInteger(count) && count > 0 ? count : 0;
  const names = ['GIT_CONFIG_COUNT', `GIT_CONFIG_KEY_${next}`, `GIT_CONFIG_VALUE_${next}`];
  const out: NodeJS.ProcessEnv = {
    ...env,
    [names[0] as string]: String(next + 1),
    [names[1] as string]: 'safe.bareRepository',
    [names[2] as string]: 'explicit',
  };
  if (env.GIT_CONFIG_PARAMETERS !== undefined) {
    out.GIT_CONFIG_PARAMETERS = [env.GIT_CONFIG_PARAMETERS, "'safe.bareRepository=explicit'"].filter(Boolean).join(' ');
    names.push('GIT_CONFIG_PARAMETERS');
  }
  return { env: out, names };
}

/** `env` without the variable `name` in any letter case, which a Windows environment treats as one. */
function withoutName(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== name));
}

/** The user's own environment, with the PATH a terminal would have rather than Finder's. */
export async function commandEnv(launch: SandboxedCommand, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  if (launch.wslDistro) {
    const crossing: NodeJS.ProcessEnv = { ...process.env, ...extra, [COMMAND_TAG_ENV]: launch.processTag };
    // Only what WSLENV names into Linux reaches it, so a Windows-side setting that does not cross is not counted on.
    const crossed = new Set(wslEnvNames(crossing).map(name => name.toUpperCase()));
    let counted = crossing;
    for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
      const value = Object.entries(crossing).find(([key]) => key.toUpperCase() === name)?.[1];
      counted = withoutName(counted, name);
      if (crossed.has(name) && value !== undefined) counted[name] = value;
    }
    const bare = withExplicitBareRepositories(counted);
    return wslCommandEnv(bare.env, launch.wslDistro, [...Object.keys(extra), COMMAND_TAG_ENV, ...bare.names]);
  }
  const base: NodeJS.ProcessEnv = { ...process.env, PATH: await resolveUserPath(), ...extra, ...launch.env };
  const env = withExplicitBareRepositories(base).env;
  if (SANDBOX_SHELL_COMMANDS) env.B4M_DESKTOP_SANDBOX = '1';
  if (launch.processTag) env[COMMAND_TAG_ENV] = launch.processTag;
  return env;
}
