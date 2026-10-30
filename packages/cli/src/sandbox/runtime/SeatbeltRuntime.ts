/**
 * macOS Seatbelt (sandbox-exec) runtime implementation.
 *
 * Generates dynamic Seatbelt profiles to restrict filesystem access.
 * Uses Apple's Sandbox framework via the `sandbox-exec` CLI tool.
 */
import { writeFileSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
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

/**
 * Escape a path for use in a Seatbelt profile.
 *
 * Seatbelt profiles use S-expression (Scheme-like) syntax where paths are
 * enclosed in quoted strings. Only two characters need escaping:
 * - Backslash (\): Must be doubled to prevent interpreting the next char as special.
 * - Double quote ("): Must be escaped to prevent closing the string prematurely.
 *
 * Scheme syntax characters like (, ), and ; do NOT need escaping because they
 * are only special at the expression parsing level. Inside a quoted string,
 * they are treated as literal characters and cannot inject directives.
 */
function escapeSeatbeltPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder';

// Data writes only, so no unlink or chmod. /dev/tty stays denied: the child shares the CLI's
// terminal, and writing to it would bypass the output the CLI sanitizes.
const DEVICE_WRITE_ALLOWS = [
  '(allow file-write-data (literal "/dev/null"))',
  '(allow file-write-data (literal "/dev/zero"))',
  '(allow file-write-data (literal "/dev/dtracehelper"))',
  '(allow file-write-data (subpath "/dev/fd"))',
];

/** Unresolvable paths keep their rule at the unresolved location instead of failing profile generation. */
function resolveProfilePath(p: string): string {
  try {
    return resolveSandboxPath(p);
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EACCES', 'ELOOP', 'EPERM'].includes(String(error.code))) {
      logger.debug(`Sandbox: using unresolved profile path ${p}: ${error.code}`);
      return p;
    }
    throw error;
  }
}

/**
 * Seatbelt matches a socket connect against the fully resolved path, so a symlink like
 * /var/run/docker.sock is denied at its current target, resolved each time a profile is built.
 * The write denies stop a socket in a writable directory from being renamed to an unlisted path,
 * directly or by renaming one of its parent directories.
 */
function containerSocketDenies(): { network: string[]; fileWrite: string[] } {
  const network = new Set<string>();
  const fileWrite = new Set<string>();
  for (const entry of getContainerSocketPaths()) {
    const resolvedParent = path.join(resolveProfilePath(path.dirname(entry.path)), path.basename(entry.path));
    for (const candidate of [resolvedParent, resolveProfilePath(entry.path)]) {
      const filter = entry.directory ? 'subpath' : 'path-literal';
      const escaped = escapeSeatbeltPath(candidate);
      network.add(`(deny network-outbound (remote unix-socket (${filter} "${escaped}")))`);
      fileWrite.add(`(deny file-write* (${filter} "${escaped}"))`);
      for (let dir = path.dirname(candidate); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        fileWrite.add(`(deny file-write* (path-literal "${escapeSeatbeltPath(dir)}"))`);
      }
    }
  }
  return { network: [...network], fileWrite: [...fileWrite] };
}

export class SeatbeltRuntime implements SandboxRuntime {
  readonly platform: SandboxPlatform = 'darwin';
  readonly name = 'seatbelt';

  isAvailable(): boolean {
    return isBinaryAvailable('sandbox-exec');
  }

  /**
   * Generate a Seatbelt profile string from the filesystem config.
   *
   * Strategy:
   * - Start with (allow default) to permit most operations
   * - Deny all file writes globally
   * - Allow file writes only to the working directory
   * - Deny all access to explicitly denied paths
   * - Allow read access to explicitly allowed paths
   */
  generateProfile(options: WrapCommandOptions): string {
    const { cwd, filesystemConfig } = options;
    const expandedDenied = filesystemConfig.deniedPaths.map(resolveSandboxPath);
    const expandedAllowed = filesystemConfig.allowedReadPaths.map(resolveSandboxPath);

    const containerDenies = options.allowContainerSockets ? null : containerSocketDenies();

    const lines: string[] = [
      '(version 1)',
      '',
      '; Start with permissive defaults (process exec, network, sysctl, etc.)',
      '(allow default)',
      '',
    ];

    // Network egress is fail-closed unless explicitly enabled (the proxy handles
    // filtering when on). `(deny network*)` denies ALL socket families - Seatbelt's
    // `network*` covers AF_UNIX, not just IP - so a bare deny would also sever local
    // IPC (ssh-agent, gpg-agent, a unix-socket postgres/redis). The
    // unix-socket re-allows below run AFTER it (Seatbelt is last-match-wins), so the
    // NET effect is an IP-only denial. This matches Linux, whose --unshare-net
    // isolates IP but not AF_UNIX. The resolver socket stays denied in every mode: mDNSResponder
    // would otherwise send DNS queries on the sandbox's behalf, a channel out even with network off.
    lines.push('; Deny all network, then re-allow local unix sockets except the DNS resolver');
    lines.push('(deny network*)');
    lines.push('(allow network-outbound (remote unix-socket))');
    lines.push('(allow network-inbound (local unix-socket))');
    lines.push('(allow network-bind (local unix-socket))');
    lines.push(`(deny network-outbound (remote unix-socket (path-literal "${MDNS_RESPONDER_SOCKET}")))`);
    if (options.networkEnabled && options.proxyPort !== undefined) {
      assertProxyPort(options.proxyPort);
      // The proxy resolves hostnames, so clients need no local DNS. Outbound loopback is limited to the
      // proxy port so other local services (databases, dev servers, engine APIs) stay unreachable.
      lines.push('; Allow outbound loopback to the filtering proxy only');
      lines.push('(allow network-bind (local ip "localhost:*"))');
      lines.push('(allow network-inbound (local ip "localhost:*"))');
      lines.push(`(allow network-outbound (remote ip "localhost:${options.proxyPort}"))`);
    }
    if (containerDenies) {
      lines.push('; Keep container engine sockets out of reach');
      lines.push(...containerDenies.network);
    }
    lines.push('');

    // Filesystem write restrictions
    if (filesystemConfig.writeOnlyToWorkingDir) {
      lines.push('; Deny all file writes globally');
      lines.push('(deny file-write*)');
      lines.push('');
      // Seatbelt matches the resolved path, so a symlinked location (os.tmpdir() is under
      // /var -> /private/var) needs its target listed too.
      const writable = (p: string) => [...new Set([p, resolveProfilePath(p)])];
      lines.push('; Allow writes to working directory');
      for (const p of writable(cwd)) lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(p)}"))`);
      lines.push('');
      // Allow writes to temp directories (needed for many tools)
      lines.push('; Allow writes to temp directories');
      lines.push(`(allow file-write* (subpath "/tmp"))`);
      lines.push(`(allow file-write* (subpath "/private/tmp"))`);
      for (const p of writable(os.tmpdir())) lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(p)}"))`);
      lines.push('');
      // `> /dev/null`, `> /dev/stderr` and git's own /dev/null opens. Writing through /dev/fd only
      // reuses a descriptor the process already holds, and cannot upgrade a read-only one.
      lines.push('; Allow writes to standard device files');
      lines.push(...DEVICE_WRITE_ALLOWS);
      lines.push('');
    }

    lines.push('; Keep protected workspace paths read-only');
    for (const protectedPath of getProtectedWorkspacePaths(cwd)) {
      lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(protectedPath)}"))`);
    }
    lines.push('');

    if (containerDenies) {
      lines.push('; Keep container engine sockets where they are');
      lines.push(...containerDenies.fileWrite, '');
    }

    // Allowed read paths (explicit allowlist, useful if we ever change default to deny reads)
    if (expandedAllowed.length > 0) {
      lines.push('; Explicitly allowed read paths');
      for (const allowedPath of expandedAllowed) {
        lines.push(`(allow file-read* (subpath "${escapeSeatbeltPath(allowedPath)}"))`);
      }
      lines.push('');
    }

    // Denies must follow ancestor read allowances and always take precedence.
    if (expandedDenied.length > 0) {
      lines.push('; Deny access to sensitive paths');
      for (const deniedPath of expandedDenied) {
        lines.push(`(deny file-read* file-write* (subpath "${escapeSeatbeltPath(deniedPath)}"))`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  wrapCommand(options: WrapCommandOptions): WrappedCommand {
    try {
      const profile = this.generateProfile(options);

      // Write profile to a temp file
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'b4m-sandbox-'));
      const profilePath = path.join(tmpDir, 'sandbox.sb');
      writeFileSync(profilePath, profile, 'utf-8');

      const args = ['-f', profilePath, 'bash', '-c', options.command];

      // Build env var prefix for the command string
      const envEntries = Object.entries(options.env ?? {});
      const envPrefix =
        envEntries.length > 0 ? envEntries.map(([k, v]) => `${k}=${shellEscape(v)}`).join(' ') + ' ' : '';

      return {
        executable: 'sandbox-exec',
        args,
        env: options.env ?? {},
        commandString: `${envPrefix}sandbox-exec -f ${profilePath} bash -c ${shellEscape(options.command)}`,
        cleanupPaths: [profilePath, tmpDir],
      };
    } catch (err) {
      throw new Error(`Failed to create sandbox profile: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Shell-escape a string for safe embedding in a command.
 */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
