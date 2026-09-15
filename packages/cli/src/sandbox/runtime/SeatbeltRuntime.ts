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
import {
  expandPath,
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
    const expandedDenied = filesystemConfig.deniedPaths.map(expandPath);
    const expandedAllowed = filesystemConfig.allowedReadPaths.map(expandPath);

    const lines: string[] = [
      '(version 1)',
      '',
      '; Start with permissive defaults (process exec, network, sysctl, etc.)',
      '(allow default)',
      '',
    ];

    // Filesystem write restrictions
    if (filesystemConfig.writeOnlyToWorkingDir) {
      lines.push('; Deny all file writes globally');
      lines.push('(deny file-write*)');
      lines.push('');
      lines.push('; Allow writes to working directory');
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(cwd)}"))`);
      lines.push('');
      // Allow writes to temp directories (needed for many tools)
      lines.push('; Allow writes to temp directories');
      lines.push(`(allow file-write* (subpath "/tmp"))`);
      lines.push(`(allow file-write* (subpath "/private/tmp"))`);
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(os.tmpdir())}"))`);
      lines.push('');
    }

    // Denied paths (block both read and write)
    if (expandedDenied.length > 0) {
      lines.push('; Deny access to sensitive paths');
      for (const deniedPath of expandedDenied) {
        lines.push(`(deny file-read* file-write* (subpath "${escapeSeatbeltPath(deniedPath)}"))`);
      }
      lines.push('');
    }

    // Allowed read paths (explicit allowlist, useful if we ever change default to deny reads)
    if (expandedAllowed.length > 0) {
      lines.push('; Explicitly allowed read paths');
      for (const allowedPath of expandedAllowed) {
        lines.push(`(allow file-read* (subpath "${escapeSeatbeltPath(allowedPath)}"))`);
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
