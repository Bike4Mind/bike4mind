/**
 * Abstract sandbox runtime adapter with platform detection and factory.
 */
import os from 'os';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import type { FilesystemConfig, SandboxPlatform, WrappedCommand } from '../types.js';

/** Options passed to wrapCommand */
export interface WrapCommandOptions {
  command: string;
  cwd: string;
  filesystemConfig: FilesystemConfig;
  env?: Record<string, string>;
  seccompProfile?: string;
  /** Grant network egress inside the sandbox. Required so every call site makes the
   *  fail-closed vs. open decision explicitly; false denies IP egress. */
  networkEnabled: boolean;
  /** Filtering proxy port; Seatbelt grants loopback-only network when set with networkEnabled. */
  proxyPort?: number;
  /** Host Unix socket forwarding to the proxy; Bubblewrap relays to it from inside an isolated net namespace. */
  proxySocketPath?: string;
  /** Leave container engine sockets (see getContainerSocketPaths) reachable inside the sandbox. */
  allowContainerSockets?: boolean;
}

export interface ContainerSocketPath {
  path: string;
  directory: boolean;
}

/** Docker, Podman, Colima, Lima, Rancher Desktop and OrbStack API sockets, or the directories holding them. */
export function getContainerSocketPaths(): ContainerSocketPath[] {
  const home = os.homedir();
  const env = process.env;
  const entries: ContainerSocketPath[] = [
    { path: '/var/run/docker.sock', directory: false },
    { path: '/run/docker.sock', directory: false },
    { path: '/run/podman', directory: true },
    { path: path.join(home, '.docker'), directory: true },
    { path: path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data'), directory: true },
    { path: path.join(home, '.colima'), directory: true },
    { path: path.join(home, '.lima'), directory: true },
    { path: path.join(home, '.rd'), directory: true },
    { path: path.join(home, '.orbstack'), directory: true },
    { path: path.join(home, '.local', 'share', 'containers'), directory: true },
    { path: path.join(os.tmpdir(), 'podman'), directory: true },
  ];
  const addIfAbsolute = (p: string | undefined, directory: boolean) => {
    if (p && path.isAbsolute(p)) entries.push({ path: p, directory });
  };
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) {
    addIfAbsolute(path.join(env.XDG_RUNTIME_DIR, 'docker.sock'), false);
    addIfAbsolute(path.join(env.XDG_RUNTIME_DIR, 'podman'), true);
  }
  for (const host of [env.DOCKER_HOST, env.CONTAINER_HOST]) {
    if (host?.startsWith('unix://')) addIfAbsolute(host.slice('unix://'.length), false);
  }
  addIfAbsolute(env.COLIMA_HOME, true);
  addIfAbsolute(env.LIMA_HOME, true);
  const configHome =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  addIfAbsolute(path.join(configHome, 'colima'), true);
  return entries;
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

/** Paths under cwd that stay read-only inside the writable working directory. */
export function getProtectedWorkspacePaths(cwd: string): string[] {
  const git = findGitEntry(cwd);
  const repositoryRoot = path.dirname(git);
  const protectedPaths = new Set([
    path.join(cwd, '.git'),
    path.join(cwd, '.bike4mind'),
    git,
    path.join(repositoryRoot, '.bike4mind'),
  ]);
  let ancestor = cwd;
  while (path.dirname(ancestor) !== ancestor) {
    if (['.git', '.bike4mind'].includes(path.basename(ancestor))) protectedPaths.add(ancestor);
    ancestor = path.dirname(ancestor);
  }
  const gitFile = readMetadataFile(git);
  const gitDirectory = gitFile?.match(/^gitdir:\s*(.+)\s*$/)?.[1];
  if (gitDirectory) {
    const metadataPath = path.resolve(repositoryRoot, gitDirectory.trim());
    protectedPaths.add(metadataPath);
    const commonDirectory = readMetadataFile(path.join(metadataPath, 'commondir'))?.trim();
    if (commonDirectory) protectedPaths.add(path.resolve(metadataPath, commonDirectory));
  }
  for (const protectedPath of [...protectedPaths]) protectedPaths.add(resolveSandboxPath(protectedPath));
  return [...protectedPaths];
}

function findGitEntry(cwd: string): string {
  let directory = cwd;
  while (true) {
    const gitPath = path.join(directory, '.git');
    try {
      lstatSync(gitPath);
      return gitPath;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)))) {
        throw error;
      }
    }
    const parentDirectory = path.dirname(directory);
    if (parentDirectory === directory) return path.join(cwd, '.git');
    directory = parentDirectory;
  }
}

function readMetadataFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(String(error.code))) {
      return undefined;
    }
    throw error;
  }
}

/** Resolve aliases so sensitive symlinks are protected at their actual target. */
export function resolveSandboxPath(pathString: string): string {
  const expandedPath = path.resolve(expandPath(pathString));
  try {
    return realpathSync(expandedPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
      const parentPath = path.dirname(expandedPath);
      return parentPath === expandedPath
        ? expandedPath
        : path.join(resolveSandboxPath(parentPath), path.basename(expandedPath));
    }
    throw error;
  }
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
