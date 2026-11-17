import { chmod, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFilePathOpenResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { MAX_PATHS_PER_CHECK, registerFilePathLinkIpc, type FilePathScope } from './filePathLinks';

const SESSION = 'session-1';

let base: string;
let project: string;
let outside: string;
let vault: string;
let deps: {
  scopeFor: ReturnType<typeof vi.fn<(sessionId: string) => Promise<FilePathScope | null>>>;
  protectedPaths: () => readonly string[];
  home: string;
  stat: typeof stat;
  openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  reveal: ReturnType<typeof vi.fn<(path: string) => void>>;
};
let check: (sessionId: unknown, paths: unknown) => Promise<(string | null)[]>;
let open: (sessionId: unknown, path: unknown) => Promise<ChatFilePathOpenResult>;

beforeEach(async () => {
  // Real paths, so macOS's /var -> /private/var link does not make the roots look different.
  base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-file-links-')));
  project = join(base, 'project');
  outside = join(base, 'outside');
  vault = join(project, 'vault');
  await mkdir(join(project, 'reports'), { recursive: true });
  await mkdir(outside);
  await mkdir(vault);
  await writeFile(join(project, 'reports', 'run.webm'), 'video');
  await writeFile(join(project, 'notes.md'), '# notes');
  await writeFile(join(project, 'build.command'), 'echo hi');
  await writeFile(join(project, 'tool'), 'echo hi');
  await chmod(join(project, 'tool'), 0o755);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await writeFile(join(vault, 'token.json'), '{}');
  await symlink(join(outside, 'secret.txt'), join(project, 'escape.txt'));

  deps = {
    scopeFor: vi.fn(async (sessionId: string) =>
      sessionId === SESSION ? { roots: [project], workingDirectory: project } : null
    ),
    protectedPaths: () => [vault],
    home: base,
    stat,
    openPath: vi.fn(async (_path: string) => ''),
    reveal: vi.fn((_path: string) => {}),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerFilePathLinkIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { ...deps, platform: 'darwin' }
  );
  check = (sessionId, paths) =>
    handlers.get(IPC_CHANNELS.chatCheckFilePaths)!({}, sessionId, paths) as Promise<(string | null)[]>;
  open = (sessionId, path) =>
    handlers.get(IPC_CHANNELS.chatOpenFilePath)!({}, sessionId, path) as Promise<ChatFilePathOpenResult>;
});

describe('checking the paths a reply names', () => {
  it('resolves what exists in the session folders, relative to its working directory', async () => {
    expect(
      await check(SESSION, ['reports/run.webm', join(project, 'notes.md'), 'reports/missing.webm', 'reports'])
    ).toEqual([join(project, 'reports', 'run.webm'), join(project, 'notes.md'), null, join(project, 'reports')]);
  });

  it('drops a cited line number to find the file', async () => {
    expect(await check(SESSION, ['notes.md:12', 'notes.md:12:3'])).toEqual([
      join(project, 'notes.md'),
      join(project, 'notes.md'),
    ]);
  });

  it('expands ~ to the home folder, still inside the roots', async () => {
    expect(await check(SESSION, ['~/project/notes.md', '~/outside/secret.txt'])).toEqual([
      join(project, 'notes.md'),
      null,
    ]);
  });

  it('refuses paths outside the roots, through a symlink, or under a protected folder', async () => {
    expect(
      await check(SESSION, [join(outside, 'secret.txt'), '../outside/secret.txt', 'escape.txt', 'vault/token.json'])
    ).toEqual([null, null, null, null]);
  });

  it('answers nothing for an unknown or malformed session, and refuses a malformed list', async () => {
    expect(await check('other', ['notes.md'])).toEqual([null]);
    expect(await check('../../etc', ['notes.md'])).toEqual([null]);
    expect(deps.scopeFor).not.toHaveBeenCalledWith('../../etc');
    expect(await check(SESSION, 'notes.md')).toEqual([]);
    expect(await check(SESSION, [42])).toEqual([]);
    expect(await check(SESSION, ['a\0b'])).toEqual([]);
    expect(
      await check(
        SESSION,
        Array.from({ length: MAX_PATHS_PER_CHECK + 1 }, () => 'notes.md')
      )
    ).toEqual([]);
  });
});

describe('opening a path a reply names', () => {
  it('opens a document in its default app', async () => {
    expect(await open(SESSION, 'reports/run.webm')).toEqual({ ok: true, opened: 'opened' });
    expect(deps.openPath).toHaveBeenCalledWith(join(project, 'reports', 'run.webm'));
    expect(deps.reveal).not.toHaveBeenCalled();
  });

  it('opens a folder in the file manager', async () => {
    expect(await open(SESSION, 'reports')).toEqual({ ok: true, opened: 'opened' });
    expect(deps.openPath).toHaveBeenCalledWith(join(project, 'reports'));
  });

  it('reveals rather than runs a script or an executable', async () => {
    expect(await open(SESSION, 'build.command')).toEqual({ ok: true, opened: 'revealed' });
    expect(await open(SESSION, 'tool')).toEqual({ ok: true, opened: 'revealed' });
    expect(deps.reveal).toHaveBeenCalledWith(join(project, 'build.command'));
    expect(deps.reveal).toHaveBeenCalledWith(join(project, 'tool'));
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it('touches nothing for a path it would not have linked', async () => {
    for (const path of [join(outside, 'secret.txt'), 'escape.txt', 'vault/token.json', 'missing.md', 42, '']) {
      const result = await open(SESSION, path);
      expect(result.ok).toBe(false);
    }
    expect((await open('other', 'notes.md')).ok).toBe(false);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });

  it('reports the error the OS gives when it cannot open the file', async () => {
    deps.openPath.mockResolvedValueOnce('No application knows how to open this file.');
    expect(await open(SESSION, 'notes.md')).toEqual({
      ok: false,
      error: 'No application knows how to open this file.',
    });
  });
});
