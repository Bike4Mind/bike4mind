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
import { lstatSync, mkdirSync, realpathSync, statSync } from 'fs';
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
import { PROXY_RELAY_SOURCE } from './proxyRelay.js';

/** System paths to bind read-only into the sandbox */
const SYSTEM_RO_BINDS = ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc'];

/** In-sandbox mount points for the proxy relay; the root is a fresh tmpfs, so nothing else lives here. */
const RELAY_DIR = '/run/b4m-sandbox';
const RELAY_NODE = `${RELAY_DIR}/node`;
const RELAY_SOCKET = `${RELAY_DIR}/proxy.sock`;

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
    // Only home entries are visible: /var/run and /run are never bound, so masking them leaves an empty mountpoint.
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
        if (resolvedCwd === socketPath || resolvedCwd.startsWith(`${socketPath}${path.sep}`)) {
          logger.debug(`Sandbox: not masking container socket path ${socketPath}, it contains the working directory`);
          continue;
        }
        if (kind === 'dir') args.push('--tmpfs', socketPath);
        else if (kind === 'file') args.push('--ro-bind', '/dev/null', socketPath);
      }
    }

    // The sandbox always gets its own network namespace, which has only loopback. With network on,
    // the relay inside it forwards the proxy port to the host proxy's Unix socket, so the proxy is
    // the only way out. Without a socket the command runs offline rather than on the host network.
    const relay =
      options.networkEnabled && options.proxyPort !== undefined && options.proxySocketPath
        ? { port: options.proxyPort, socketPath: options.proxySocketPath }
        : null;
    if (options.networkEnabled && !relay) {
      logger.debug('Sandbox: no proxy socket available, running without network');
    }
    if (relay) {
      if (!Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535) {
        throw new Error(`Invalid proxy port: ${relay.port}`);
      }
      args.push('--ro-bind', realpathSync(process.execPath), RELAY_NODE);
      args.push('--ro-bind', relay.socketPath, RELAY_SOCKET);
    }
    args.push('--unshare-all');
    args.push('--unshare-net');
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

    if (relay) {
      args.push(RELAY_NODE, '-e', PROXY_RELAY_SOURCE, String(relay.port), RELAY_SOCKET, command);
    } else {
      args.push('bash', '-c', command);
    }

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
