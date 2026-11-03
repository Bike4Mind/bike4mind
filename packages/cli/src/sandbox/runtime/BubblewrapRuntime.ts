/**
 * Linux Bubblewrap (bwrap) runtime implementation.
 *
 * Uses bubblewrap to create a sandboxed environment with:
 * - Read-only system paths (/usr, /lib, /bin, etc.)
 * - Read-write access only to the working directory
 * - Denied paths mounted as empty tmpfs
 * - Process and network namespace isolation; egress only through the filtering proxy
 */
import os from 'os';
import path from 'path';
import { lstatSync, mkdirSync, statSync } from 'fs';
import type { SandboxPlatform, WrappedCommand } from '../types.js';
import { logger } from '../../utils/Logger.js';
import {
  assertProxyPort,
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

/** Where the proxy's host unix socket is mounted; /run is never bound from the host, so nothing shadows it. */
const SANDBOX_PROXY_SOCKET = '/run/b4m/proxy.sock';

/** Readiness probes for the in-sandbox relay, 50ms apart. */
const RELAY_READY_ATTEMPTS = 100;

/**
 * Listen on the sandbox's own loopback at the proxy port, so the proxy env vars work unchanged, and
 * forward to the mounted socket. The command runs as "$1" once the relay accepts connections.
 */
function relayScript(proxyPort: number): string {
  return [
    `socat TCP-LISTEN:${proxyPort},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${SANDBOX_PROXY_SOCKET} </dev/null >/dev/null 2>&1 &`,
    'attempts=0',
    `until (: </dev/tcp/127.0.0.1/${proxyPort}) 2>/dev/null; do`,
    '  attempts=$((attempts + 1))',
    `  if [ "$attempts" -ge ${RELAY_READY_ATTEMPTS} ]; then echo 'sandbox: network relay failed to start' >&2; exit 1; fi`,
    '  sleep 0.05',
    'done',
    'exec bash -c "$1"',
  ].join('\n');
}

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

    // The network namespace is never shared: bwrap brings up only loopback in it, so the mounted
    // proxy socket is the sole way out. Fail closed if that route cannot be built.
    let relayPort: number | null = null;
    if (options.networkEnabled) {
      if (options.proxyPort === undefined || !options.proxySocketPath) {
        throw new Error('Sandbox network on Linux requires a running filtering proxy with a unix socket');
      }
      assertProxyPort(options.proxyPort);
      if (!isBinaryAvailable('socat')) {
        throw new Error('Sandbox network on Linux requires socat; install it or turn sandbox network off');
      }
      relayPort = options.proxyPort;
      args.push('--ro-bind', options.proxySocketPath, SANDBOX_PROXY_SOCKET);
    }

    // --unshare-all already unshares net; --unshare-net is an explicit, greppable marker of intent.
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

    if (relayPort === null) args.push('bash', '-c', command);
    else args.push('bash', '-c', relayScript(relayPort), 'b4m-sandbox', command);

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
