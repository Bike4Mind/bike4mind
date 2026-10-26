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
import { lstatSync, mkdirSync, statSync } from 'fs';
import type { SandboxPlatform, WrappedCommand } from '../types.js';
import { logger } from '../../utils/Logger.js';
import {
  resolveSandboxPath,
  getContainerSocketPaths,
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
    const expandedDenied = filesystemConfig.deniedPaths.map(resolveSandboxPath);
    const expandedAllowed = filesystemConfig.allowedReadPaths.map(resolveSandboxPath);

    const args: string[] = [];

    // System read-only binds (use --ro-bind-try to avoid TOCTOU race)
    for (const sysPath of SYSTEM_RO_BINDS) {
      args.push('--ro-bind-try', sysPath, sysPath);
    }

    // Special mounts
    args.push('--dev', SPECIAL_MOUNTS.dev);
    args.push('--proc', SPECIAL_MOUNTS.proc);
    args.push('--tmpfs', SPECIAL_MOUNTS.tmp);

    // Parent mounts must precede child mounts or they shadow the writable cwd.
    const homeDir = os.homedir();
    args.push('--ro-bind', homeDir, homeDir);

    // Allowed read paths (already covered by home bind, but explicit for non-home paths)
    for (const allowedPath of expandedAllowed) {
      if (allowedPath !== homeDir && !allowedPath.startsWith(`${homeDir}${path.sep}`)) {
        args.push('--ro-bind-try', allowedPath, allowedPath);
      }
    }

    args.push('--bind', cwd, cwd);

    // Protect the whole metadata directory, including config/hooks that do not exist yet.
    // Git writes require the usual unsandboxed permission escalation.
    const protectedPaths = getProtectedWorkspacePaths(cwd);
    const resolvedCwd = resolveSandboxPath(cwd);
    for (const protectedPath of protectedPaths) {
      const resolvedPath = resolveSandboxPath(protectedPath);
      if (resolvedCwd === resolvedPath || resolvedCwd.startsWith(`${resolvedPath}${path.sep}`)) {
        throw new Error(`Cannot use protected metadata as sandbox cwd: ${cwd}`);
      }
    }
    const projectDir = path.join(cwd, '.bike4mind');
    mkdirSync(projectDir, { recursive: true });
    for (const protectedPath of protectedPaths) {
      try {
        if (lstatSync(protectedPath).isSymbolicLink()) {
          throw new Error(`Cannot protect sandbox metadata symlink: ${protectedPath}`);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)))) {
          throw error;
        }
      }
      const resolvedPath = resolveSandboxPath(protectedPath);
      if (protectedPath === projectDir || pathKind(resolvedPath) !== 'missing') {
        args.push('--ro-bind', resolvedPath, resolvedPath);
      }
    }

    // Denied paths: hide dirs behind an empty tmpfs and files behind /dev/null; skip missing ones
    for (const deniedPath of expandedDenied) {
      const kind = pathKind(deniedPath);
      if (kind === 'dir') args.push('--tmpfs', deniedPath);
      else if (kind === 'file') args.push('--ro-bind', '/dev/null', deniedPath);
    }

    // connect() works on a read-only bind, so container sockets need masking too.
    if (!options.allowContainerSockets) {
      const isDenied = (p: string) => expandedDenied.some(d => p === d || p.startsWith(`${d}${path.sep}`));
      for (const entry of getContainerSocketPaths()) {
        let socketPath: string;
        let kind: ReturnType<typeof pathKind>;
        try {
          socketPath = resolveSandboxPath(entry.path);
          kind = pathKind(socketPath);
        } catch (error) {
          if (error instanceof Error && 'code' in error && ['EACCES', 'ELOOP'].includes(String(error.code))) {
            logger.debug(`Sandbox: skipping unreadable container socket path ${entry.path}: ${error.code}`);
            continue;
          }
          throw error;
        }
        if (isDenied(socketPath)) continue;
        if (kind === 'dir') args.push('--tmpfs', socketPath);
        else if (kind === 'file') args.push('--ro-bind', '/dev/null', socketPath);
      }
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
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
      return 'missing';
    }
    throw error;
  }
}

function shellEscape(str: string): string {
  // If the string contains no special chars, return as-is
  if (/^[a-zA-Z0-9._/=:-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}
