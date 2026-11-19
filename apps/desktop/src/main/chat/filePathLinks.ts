import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMain } from 'electron';
import type {
  AddAttachmentsResult,
  ChatFilePathAction,
  ChatFilePathActionResult,
  ChatFilePathOpenResult,
  ChatFileView,
} from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { isValidSessionId } from './SessionStore';
import { realpathNearest, resolveWithinRoots, withinGuarded } from './tools/paths';

/** Bounds on what one check may ask for: a reply that names thousands of paths is not one to link. */
export const MAX_PATHS_PER_CHECK = 200;
const MAX_PATH_LENGTH = 1024;
/** How much of a file the Files pane is sent; a longer one is shown up to here and says so. */
export const MAX_VIEW_BYTES = 1024 * 1024;
/** A NUL in this much of the start is taken to mean the file is not text. */
const BINARY_SNIFF_BYTES = 8000;

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
  '.hta',
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
  copyText(text: string): Promise<void>;
  /** Into the session's draft, through the same intake as the attachment picker. */
  attach(sessionId: string, path: string): Promise<AddAttachmentsResult>;
  platform?: NodeJS.Platform;
}

const ACTIONS: ReadonlySet<string> = new Set<ChatFilePathAction>([
  'copy-path',
  'copy-relative-path',
  'copy-markdown',
  'reveal',
]);

/**
 * `path` as the user would type it from the working directory, or from the shared folder that
 * holds it when it is outside that; the absolute path when neither holds it.
 */
export function relativeTo(path: string, scope: FilePathScope): string {
  const bases = [scope.workingDirectory, ...scope.roots].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const rel = relative(base, path);
    if (rel === '') return '.';
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return path;
}

/** A Markdown link to the file. Square brackets in the name are escaped so the text stays one label. */
export function markdownFileLink(path: string): string {
  const label = basename(path).replace(/[\\[\]]/g, char => `\\${char}`);
  return `[${label}](${pathToFileURL(path).href})`;
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
): Promise<{ path: string; stats: Stats; line?: number } | null> {
  const expanded = /^~[\\/]/.test(requested) ? join(deps.home, requested.slice(2)) : requested;
  const suffix = LINE_SUFFIX.exec(expanded);
  const spellings = suffix ? [expanded, expanded.slice(0, suffix.index)] : [expanded];
  for (const [index, spelling] of spellings.entries()) {
    let path: string;
    try {
      path = await resolveWithinRoots(spelling, scope.roots, scope.workingDirectory);
    } catch {
      continue;
    }
    const real = await realpathNearest(path);
    if (withinGuarded(deps.protectedPaths(), [path, real], deps.platform)) return null;
    try {
      const stats = await deps.stat(path);
      // The second spelling is the one with the cited line dropped: `:12:5` names line 12.
      const line = index === 1 && suffix ? Number(suffix[0].slice(1).split(':')[0]) : undefined;
      return line ? { path, stats, line } : { path, stats };
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

/** The first `bytes` of a file: the Files pane never needs more, and a log can be gigabytes. */
async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * What the Files pane shows for a resolved path. Only regular files that read as text come back
 * with their text; a folder or a binary file is named so the renderer can hand it to the OS.
 */
async function viewOf(found: { path: string; stats: Stats; line?: number }): Promise<ChatFileView> {
  const base = { path: resolve(found.path), name: basename(found.path), size: found.stats.size };
  if (found.stats.isDirectory()) return { kind: 'directory', ...base };
  if (!found.stats.isFile()) return { kind: 'binary', ...base };
  const head = await readHead(found.path, MAX_VIEW_BYTES);
  if (head.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary', ...base };
  // A cut can land inside a multi-byte character; the decoder turns that tail into one U+FFFD.
  const text = head.toString('utf8');
  return {
    kind: 'text',
    ...base,
    text,
    truncated: found.stats.size > head.length,
    ...(found.line ? { line: found.line } : {}),
  };
}

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

  ipc.handle(
    IPC_CHANNELS.chatFilePathAction,
    async (_event, sessionId: unknown, value: unknown, action: unknown): Promise<ChatFilePathActionResult> => {
      if (typeof value !== 'string' || !isPathText(value)) return { ok: false, error: GONE };
      if (typeof action !== 'string' || !ACTIONS.has(action)) return { ok: false, error: GONE };
      try {
        const scope = await scopeOf(sessionId);
        const found = scope && (await resolveOne(value, scope, deps));
        if (!scope || !found) return { ok: false, error: GONE };
        const path = resolve(found.path);
        switch (action as ChatFilePathAction) {
          case 'copy-path':
            await deps.copyText(path);
            break;
          case 'copy-relative-path':
            await deps.copyText(relativeTo(path, scope));
            break;
          case 'copy-markdown':
            await deps.copyText(markdownFileLink(path));
            break;
          case 'reveal':
            deps.reveal(path);
            break;
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipc.handle(
    IPC_CHANNELS.chatAttachFilePath,
    async (_event, sessionId: unknown, value: unknown): Promise<AddAttachmentsResult> => {
      if (typeof value !== 'string' || !isPathText(value)) {
        return { attachments: [], rejected: [{ name: 'file', reason: GONE }] };
      }
      const name = basename(value) || 'file';
      const gone: AddAttachmentsResult = { attachments: [], rejected: [{ name, reason: GONE }] };
      try {
        const scope = await scopeOf(sessionId);
        const found = scope && (await resolveOne(value, scope, deps));
        // scopeOf has already refused an id that is not a valid session id.
        return found ? await deps.attach(sessionId as string, resolve(found.path)) : gone;
      } catch {
        return { attachments: [], rejected: [{ name, reason: 'That file could not be attached.' }] };
      }
    }
  );

  ipc.handle(
    IPC_CHANNELS.chatReadFilePath,
    async (_event, sessionId: unknown, value: unknown): Promise<ChatFileView> => {
      if (typeof value !== 'string' || !isPathText(value)) return { kind: 'error', error: GONE };
      try {
        const scope = await scopeOf(sessionId);
        const found = scope && (await resolveOne(value, scope, deps));
        return found ? await viewOf(found) : { kind: 'error', error: GONE };
      } catch (error) {
        return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
