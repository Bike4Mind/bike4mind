import { randomUUID } from 'node:crypto';
import { COMMAND_TAG_ENV } from './commandTree';
import { resolveGitBash } from './gitBash';
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
  protectedPaths: readonly string[]
): Promise<SandboxedCommand> {
  if (SANDBOX_SHELL_COMMANDS) {
    if (!sandboxAvailable()) {
      throw new Error('Commands cannot be run on this machine: the macOS sandbox is unavailable.');
    }
    return sandboxCommand(command, roots, protectedPaths);
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

/** The user's own environment, with the PATH a terminal would have rather than Finder's. */
export async function commandEnv(launch: SandboxedCommand, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await resolveUserPath(), ...extra, ...launch.env };
  if (SANDBOX_SHELL_COMMANDS) env.B4M_DESKTOP_SANDBOX = '1';
  if (launch.processTag) env[COMMAND_TAG_ENV] = launch.processTag;
  return env;
}
