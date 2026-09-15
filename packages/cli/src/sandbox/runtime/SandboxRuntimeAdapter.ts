/**
 * Abstract sandbox runtime adapter with platform detection and factory.
 */
import os from 'os';
import { accessSync, constants } from 'fs';
import path from 'path';
import type { FilesystemConfig, SandboxPlatform, WrappedCommand } from '../types.js';

/** Options passed to wrapCommand */
export interface WrapCommandOptions {
  command: string;
  cwd: string;
  filesystemConfig: FilesystemConfig;
  env?: Record<string, string>;
  seccompProfile?: string;
}

/** Abstract interface for platform-specific sandbox runtimes */
export interface SandboxRuntime {
  /** The platform this runtime supports */
  readonly platform: SandboxPlatform;
  /** Human-readable runtime name (e.g., 'seatbelt', 'bubblewrap') */
  readonly name: string;
  /** Check if the sandbox runtime binary is available on this system */
  isAvailable(): boolean;
  /** Wrap a command with sandbox restrictions */
  wrapCommand(options: WrapCommandOptions): WrappedCommand;
}

/**
 * Detect the current platform.
 * Returns null if the platform is not supported for sandboxing.
 */
export function detectPlatform(): SandboxPlatform | null {
  const platform = os.platform();
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return null;
}

/**
 * Check if a binary exists on the system PATH.
 * Uses pure filesystem checks instead of shell execution to avoid command injection.
 */
export function isBinaryAvailable(binary: string): boolean {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    try {
      accessSync(path.join(dir, binary), constants.X_OK);
      return true;
    } catch {
      // Continue to next dir
    }
  }
  return false;
}

/**
 * Expand environment variables ($HOME, $USER) in a path string.
 */
export function expandPath(pathStr: string): string {
  return pathStr
    .replace(/\$HOME/g, os.homedir())
    .replace(/\$USER/g, os.userInfo().username)
    .replace(/~\//g, `${os.homedir()}/`);
}

/**
 * Factory function to create the appropriate sandbox runtime for the current platform.
 * Returns null if the platform is unsupported or the runtime binary is not available.
 */
export async function createSandboxRuntime(): Promise<SandboxRuntime | null> {
  const platform = detectPlatform();
  if (!platform) return null;

  if (platform === 'darwin') {
    const { SeatbeltRuntime } = await import('./SeatbeltRuntime.js');
    const runtime = new SeatbeltRuntime();
    return runtime.isAvailable() ? runtime : null;
  }

  if (platform === 'linux') {
    const { BubblewrapRuntime } = await import('./BubblewrapRuntime.js');
    const runtime = new BubblewrapRuntime();
    return runtime.isAvailable() ? runtime : null;
  }

  return null;
}
