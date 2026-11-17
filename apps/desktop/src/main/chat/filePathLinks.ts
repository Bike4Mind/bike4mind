import type { Stats } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { IpcMain } from 'electron';
import type { ChatFilePathOpenResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { isValidSessionId } from './SessionStore';
import { realpathNearest, resolveWithinRoots, withinGuarded } from './tools/paths';

/** Bounds on what one check may ask for: a reply that names thousands of paths is not one to link. */
export const MAX_PATHS_PER_CHECK = 200;
const MAX_PATH_LENGTH = 1024;

const GONE = 'That file is not in a folder shared with this conversation, or no longer exists.';

/**
 * Types the OS would run, or launch something from, rather than show. Clicking one of these is
 * answered with a reveal instead: a link a reply drew must never be one click from running code.
 * Lower case, with the dot.
 */
const RUNNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.app',
  '.applescript',
  '.appimage',
  '.bat',
  '.bin',
  '.cmd',
  '.com',
  '.command',
  '.cpl',
  '.csh',
  '.desktop',
  '.dmg',
  '.exe',
  '.fileloc',
  '.fish',
  '.inetloc',
  '.jar',
  '.js',
  '.jse',
  '.ksh',
  '.lnk',
  '.mpkg',
  '.msi',
  '.msp',
  '.pkg',
  '.pl',
  '.prefpane',
  '.ps1',
  '.py',
  '.rb',
  '.reg',
  '.run',
  '.saver',
  '.scpt',
  '.scr',
  '.sh',
  '.terminal',
  '.tool',
  '.url',
  '.vbe',
  '.vbs',
  '.webloc',
  '.workflow',
  '.ws',
  '.wsf',
  '.zsh',
]);

export interface FilePathScope {
  roots: readonly string[];
  workingDirectory?: string;
}

export interface FilePathLinkDeps {
  /** The folders this session's tools may read, or null when the session does not exist. */
  scopeFor(sessionId: string): Promise<FilePathScope | null>;
  /** Paths no tool may reach whatever was granted (the auth vault). */
  protectedPaths(): readonly string[];
  home: string;
  stat(path: string): Promise<Stats>;
  /** Electron's shell.openPath: resolves to an error message, empty on success. */
  openPath(path: string): Promise<string>;
  reveal(path: string): void;
  platform?: NodeJS.Platform;
}

/** `file.ts:12` and `file.ts:12:5`, as a reply cites a line. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/**
 * Where `requested` lands for this session, or null. The same check the file tools make
 * (resolveWithinRoots, symlinks followed), plus the tools' protected paths, so a link can reach
 * exactly what the model could already read and nothing more.
 */
async function resolveOne(
  requested: string,
  scope: FilePathScope,
  deps: FilePathLinkDeps
): Promise<{ path: string; stats: Stats } | null> {
  const expanded = /^~[\\/]/.test(requested) ? join(deps.home, requested.slice(2)) : requested;
  const spellings = LINE_SUFFIX.test(expanded) ? [expanded, expanded.replace(LINE_SUFFIX, '')] : [expanded];
  for (const spelling of spellings) {
    let path: string;
    try {
      path = await resolveWithinRoots(spelling, scope.roots, scope.workingDirectory);
    } catch {
      continue;
    }
    const real = await realpathNearest(path);
    if (withinGuarded(deps.protectedPaths(), [path, real], deps.platform)) return null;
    try {
      return { path, stats: await deps.stat(path) };
    } catch {
      // Not there under this spelling; the next drops the line suffix.
    }
  }
  return null;
}

/** Whether opening `path` would run something rather than show it. */
export function isRunnable(path: string, stats: Pick<Stats, 'isDirectory' | 'mode'>, platform = process.platform) {
  if (RUNNABLE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  // A directory opens in the file manager; its x bits only mean it can be entered.
  if (stats.isDirectory()) return false;
  return platform !== 'win32' && (stats.mode & 0o111) !== 0;
}

/** Strings from the renderer, checked before any of them reaches the filesystem. */
function parsePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATHS_PER_CHECK) return null;
  if (!value.every(path => typeof path === 'string' && isPathText(path))) return null;
  return value as string[];
}

const isPathText = (path: string) => path.length > 0 && path.length <= MAX_PATH_LENGTH && !path.includes('\0');

/**
 * The channels behind a file path a reply names: which ones exist for this session, and opening
 * one. Nothing the renderer sends is used as a path until it has been resolved against the
 * session's roots here, since it is read out of model output.
 */
export function registerFilePathLinkIpc(ipc: Pick<IpcMain, 'handle'>, deps: FilePathLinkDeps): void {
  const scopeOf = async (sessionId: unknown): Promise<FilePathScope | null> =>
    typeof sessionId === 'string' && isValidSessionId(sessionId) ? deps.scopeFor(sessionId) : null;

  ipc.handle(IPC_CHANNELS.chatCheckFilePaths, async (_event, sessionId: unknown, value: unknown) => {
    const paths = parsePaths(value);
    if (!paths) return [];
    const scope = await scopeOf(sessionId).catch(() => null);
    if (!scope || scope.roots.length === 0) return paths.map(() => null);
    return Promise.all(
      paths.map(async path => {
        const found = await resolveOne(path, scope, deps).catch(() => null);
        return found ? resolve(found.path) : null;
      })
    );
  });

  ipc.handle(
    IPC_CHANNELS.chatOpenFilePath,
    async (_event, sessionId: unknown, value: unknown): Promise<ChatFilePathOpenResult> => {
      if (typeof value !== 'string' || !isPathText(value)) return { ok: false, error: GONE };
      try {
        const scope = await scopeOf(sessionId);
        const found = scope && (await resolveOne(value, scope, deps));
        if (!found) return { ok: false, error: GONE };
        if (isRunnable(found.path, found.stats, deps.platform)) {
          deps.reveal(found.path);
          return { ok: true, opened: 'revealed' };
        }
        const error = await deps.openPath(found.path);
        return error ? { ok: false, error } : { ok: true, opened: 'opened' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
