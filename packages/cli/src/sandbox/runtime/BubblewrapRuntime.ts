/**
 * Linux Bubblewrap (bwrap) runtime implementation.
 *
 * Uses bubblewrap to create a sandboxed environment with:
 * - Read-only system paths (/usr, /lib, /bin, etc.)
 * - Read-write access only to the working directory
 * - Denied paths mounted as empty tmpfs
 * - Process namespace isolation
 */
import os from 'os';
import type { SandboxPlatform, WrappedCommand } from '../types.js';
import {
  expandPath,
  isBinaryAvailable,
  type SandboxRuntime,
  type WrapCommandOptions,
} from './SandboxRuntimeAdapter.js';

/** System paths to bind read-only into the sandbox */
const SYSTEM_RO_BINDS = ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc'];

/** Paths that need special handling (dev, proc, tmp) */
const SPECIAL_MOUNTS = {
  dev: '/dev',
  proc: '/proc',
  tmp: '/tmp',
};

export class BubblewrapRuntime implements SandboxRuntime {
  readonly platform: SandboxPlatform = 'linux';
  readonly name = 'bubblewrap';

  isAvailable(): boolean {
    return isBinaryAvailable('bwrap');
  }

  wrapCommand(options: WrapCommandOptions): WrappedCommand {
    const { command, cwd, filesystemConfig, env } = options;
    const expandedDenied = filesystemConfig.deniedPaths.map(expandPath);
    const expandedAllowed = filesystemConfig.allowedReadPaths.map(expandPath);

    const args: string[] = [];

    // System read-only binds (use --ro-bind-try to avoid TOCTOU race)
    for (const sysPath of SYSTEM_RO_BINDS) {
      args.push('--ro-bind-try', sysPath, sysPath);
    }

    // Special mounts
    args.push('--dev', SPECIAL_MOUNTS.dev);
    args.push('--proc', SPECIAL_MOUNTS.proc);
    args.push('--tmpfs', SPECIAL_MOUNTS.tmp);

    // Working directory: read-write bind
    args.push('--bind', cwd, cwd);

    // Home directory: bind read-only for tool configs, then overlay denied paths
    const homeDir = os.homedir();
    args.push('--ro-bind', homeDir, homeDir);

    // Allowed read paths (already covered by home bind, but explicit for non-home paths)
    for (const allowedPath of expandedAllowed) {
      if (!allowedPath.startsWith(homeDir)) {
        args.push('--ro-bind-try', allowedPath, allowedPath);
      }
    }

    // Denied paths: mount empty tmpfs to hide contents
    for (const deniedPath of expandedDenied) {
      args.push('--tmpfs', deniedPath);
    }

    // Write restrictions: if writeOnlyToWorkingDir, make home read-only
    // (already done above with --ro-bind for home)

    // Namespace isolation
    args.push('--unshare-all');
    args.push('--share-net'); // Keep network access (proxy handles filtering in future)
    args.push('--die-with-parent');

    // Seccomp profile (optional)
    if (options.seccompProfile) {
      args.push('--seccomp', options.seccompProfile);
    }

    // Inject environment variables
    for (const [key, value] of Object.entries(env ?? {})) {
      args.push('--setenv', key, value);
    }

    // Set working directory
    args.push('--chdir', cwd);

    // The command to execute inside the sandbox
    args.push('bash', '-c', command);

    // Build the full command string for CLI-level wrapping
    const commandString = ['bwrap', ...args.map(shellEscape)].join(' ');

    return {
      executable: 'bwrap',
      args,
      env: env ?? {},
      commandString,
    };
  }
}

function shellEscape(str: string): string {
  // If the string contains no special chars, return as-is
  if (/^[a-zA-Z0-9._/=:-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}
