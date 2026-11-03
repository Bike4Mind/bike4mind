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

export async function launchCommand(
  command: string,
  roots: readonly string[],
  protectedPaths: readonly string[]
): Promise<SandboxedCommand> {
  if (process.platform === 'win32') {
    return {
      executable: await resolveGitBash(),
      args: ['-c', command],
      processTag: randomUUID(),
      cleanup: async () => undefined,
    };
  }
  if (!SANDBOX_SHELL_COMMANDS) {
    return { executable: '/bin/bash', args: ['-c', command], cleanup: async () => undefined };
  }
  if (!sandboxAvailable()) {
    throw new Error('Commands cannot be run on this machine: the macOS sandbox is unavailable.');
  }
  return sandboxCommand(command, roots, protectedPaths);
}

/** The user's own environment, with the PATH a terminal would have rather than Finder's. */
export async function commandEnv(launch: SandboxedCommand, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await resolveUserPath(), ...extra };
  if (SANDBOX_SHELL_COMMANDS) env.B4M_DESKTOP_SANDBOX = '1';
  if (launch.processTag) env[COMMAND_TAG_ENV] = launch.processTag;
  return env;
}
