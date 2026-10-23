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
import path from 'path';
import { mkdirSync, statSync } from 'fs';
import type { SandboxPlatform, WrappedCommand } from '../types.js';
import {
  expandPath,
  getProtectedWorkspacePaths,
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

    // Later mounts shadow earlier ones, so these re-binds must follow the cwd bind
    // A bind mountpoint cannot be renamed or removed (EBUSY); a worktree .git file is bound read-only
    const gitPath = path.join(cwd, '.git');
    const gitKind = pathKind(gitPath);
    if (gitKind === 'dir') args.push('--bind', gitPath, gitPath);
    else if (gitKind === 'file') args.push('--ro-bind', gitPath, gitPath);

    // --ro-bind needs an existing source, so create the project dir first
    const projectDir = path.join(cwd, '.bike4mind');
    let projectDirReady = true;
    try {
      mkdirSync(projectDir, { recursive: true });
    } catch {
      projectDirReady = false;
    }
    for (const protectedPath of getProtectedWorkspacePaths(cwd)) {
      if (protectedPath === projectDir) {
        if (projectDirReady) args.push('--ro-bind', protectedPath, protectedPath);
      } else {
        args.push('--ro-bind-try', protectedPath, protectedPath);
      }
    }

    // Home directory: bind read-only for tool configs, then overlay denied paths
    const homeDir = os.homedir();
    args.push('--ro-bind', homeDir, homeDir);

    // Allowed read paths (already covered by home bind, but explicit for non-home paths)
    for (const allowedPath of expandedAllowed) {
      if (!allowedPath.startsWith(homeDir)) {
        args.push('--ro-bind-try', allowedPath, allowedPath);
      }
    }

    // Denied paths: hide dirs behind an empty tmpfs and files behind /dev/null; skip missing ones
    for (const deniedPath of expandedDenied) {
      const kind = pathKind(deniedPath);
      if (kind === 'dir') args.push('--tmpfs', deniedPath);
      else if (kind === 'file') args.push('--ro-bind', '/dev/null', deniedPath);
    }

    // Write restrictions: if writeOnlyToWorkingDir, make home read-only
    // (already done above with --ro-bind for home)

    // Namespace isolation. Egress is fail-closed: share the net namespace only
    // when network is explicitly enabled (proxy handles filtering). --unshare-all
    // already unshares net, so in the disabled case --unshare-net changes nothing
    // and is emitted purely as an explicit, greppable marker of intent; --share-net
    // is what actually re-grants the namespace when enabled.
    args.push('--unshare-all');
    args.push(options.networkEnabled ? '--share-net' : '--unshare-net');
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

function pathKind(p: string): 'dir' | 'file' | 'missing' {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

function shellEscape(str: string): string {
  // If the string contains no special chars, return as-is
  if (/^[a-zA-Z0-9._/=:-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}
