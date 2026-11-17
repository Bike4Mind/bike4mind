import { chmod, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AddAttachmentsResult,
  ChatFilePathActionResult,
  ChatFilePathOpenResult,
  ChatFileView,
} from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  markdownFileLink,
  MAX_PATHS_PER_CHECK,
  MAX_VIEW_BYTES,
  registerFilePathLinkIpc,
  relativeTo,
  type FilePathScope,
} from './filePathLinks';

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
  copyText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  attach: ReturnType<typeof vi.fn<(sessionId: string, path: string) => Promise<AddAttachmentsResult>>>;
};
let check: (sessionId: unknown, paths: unknown) => Promise<(string | null)[]>;
let open: (sessionId: unknown, path: unknown) => Promise<ChatFilePathOpenResult>;
let read: (sessionId: unknown, path: unknown) => Promise<ChatFileView>;
let act: (sessionId: unknown, path: unknown, action: unknown) => Promise<ChatFilePathActionResult>;
let attach: (sessionId: unknown, path: unknown) => Promise<AddAttachmentsResult>;

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
    copyText: vi.fn(async (_text: string) => {}),
    attach: vi.fn(async (_sessionId: string, _path: string) => ({ attachments: [], rejected: [] })),
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
  read = (sessionId, path) =>
    handlers.get(IPC_CHANNELS.chatReadFilePath)!({}, sessionId, path) as Promise<ChatFileView>;
  act = (sessionId, path, action) =>
    handlers.get(IPC_CHANNELS.chatFilePathAction)!({}, sessionId, path, action) as Promise<ChatFilePathActionResult>;
  attach = (sessionId, path) =>
    handlers.get(IPC_CHANNELS.chatAttachFilePath)!({}, sessionId, path) as Promise<AddAttachmentsResult>;
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

  it.each(['document.hta', 'document.HTA'])('reveals Windows HTML applications without launching %s', async name => {
    await writeFile(join(project, name), '<html>inert fixture</html>');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerFilePathLinkIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { ...deps, platform: 'win32' }
    );
    const result = await handlers.get(IPC_CHANNELS.chatOpenFilePath)!({}, SESSION, name);
    expect(result).toEqual({ ok: true, opened: 'revealed' });
    expect(deps.reveal).toHaveBeenCalledWith(join(project, name));
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

describe('the file link menu actions', () => {
  it('copies the absolute path, the path relative to the working directory, and a Markdown link', async () => {
    expect(await act(SESSION, 'reports/run.webm:3', 'copy-path')).toEqual({ ok: true });
    expect(await act(SESSION, join(project, 'reports', 'run.webm'), 'copy-relative-path')).toEqual({ ok: true });
    expect(await act(SESSION, 'notes.md', 'copy-markdown')).toEqual({ ok: true });
    expect(deps.copyText.mock.calls.map(call => call[0])).toEqual([
      join(project, 'reports', 'run.webm'),
      join('reports', 'run.webm'),
      `[notes.md](file://${join(project, 'notes.md')})`,
    ]);
  });

  it('reveals any file it would link, a script included', async () => {
    expect(await act(SESSION, 'build.command', 'reveal')).toEqual({ ok: true });
    expect(deps.reveal).toHaveBeenCalledWith(join(project, 'build.command'));
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it('touches nothing for a path it would not have linked, or an unknown action', async () => {
    for (const path of [join(outside, 'secret.txt'), 'escape.txt', 'vault/token.json', 'missing.md', 42, '']) {
      expect((await act(SESSION, path, 'copy-path')).ok).toBe(false);
    }
    expect((await act('other', 'notes.md', 'reveal')).ok).toBe(false);
    expect((await act(SESSION, 'notes.md', 'open')).ok).toBe(false);
    expect((await act(SESSION, 'notes.md', 42)).ok).toBe(false);
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });

  it('attaches the resolved file to the session draft', async () => {
    await attach(SESSION, 'notes.md:4');
    expect(deps.attach).toHaveBeenCalledWith(SESSION, join(project, 'notes.md'));
  });

  it('attaches nothing it would not have linked', async () => {
    for (const path of [join(outside, 'secret.txt'), 'escape.txt', 'vault/token.json', 'missing.md', 42]) {
      const result = await attach(SESSION, path);
      expect(result.attachments).toEqual([]);
      expect(result.rejected).toHaveLength(1);
    }
    expect((await attach('../../etc', 'notes.md')).rejected).toHaveLength(1);
    expect(deps.attach).not.toHaveBeenCalled();
  });
});

describe('relativeTo', () => {
  it('prefers the working directory, then the root that holds the path', () => {
    const scope = { roots: ['/work/a', '/work/b'], workingDirectory: '/work/a/app' };
    expect(relativeTo('/work/a/app/src/x.ts', scope)).toBe(join('src', 'x.ts'));
    expect(relativeTo('/work/a/lib/y.ts', scope)).toBe(join('lib', 'y.ts'));
    expect(relativeTo('/work/b/z.ts', scope)).toBe('z.ts');
    expect(relativeTo('/work/a/app', scope)).toBe('.');
  });
});

describe('markdownFileLink', () => {
  it('escapes brackets in the name and encodes the URL', () => {
    expect(markdownFileLink('/work/my [draft].md')).toBe('[my \\[draft\\].md](file:///work/my%20%5Bdraft%5D.md)');
  });
});

describe('reading a path a reply names for the Files pane', () => {
  it('returns a text file with its absolute path, name and size', async () => {
    expect(await read(SESSION, 'notes.md')).toEqual({
      kind: 'text',
      path: join(project, 'notes.md'),
      name: 'notes.md',
      size: 7,
      text: '# notes',
      truncated: false,
    });
  });

  it('carries the line a cited path names', async () => {
    const view = await read(SESSION, 'notes.md:12:3');
    expect(view).toMatchObject({ kind: 'text', path: join(project, 'notes.md'), line: 12 });
  });

  it('names a folder or a binary file without sending its contents', async () => {
    await writeFile(join(project, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(await read(SESSION, 'reports')).toMatchObject({ kind: 'directory', path: join(project, 'reports') });
    const binary = await read(SESSION, 'image.bin');
    expect(binary).toMatchObject({ kind: 'binary', name: 'image.bin', size: 6 });
    expect(binary).not.toHaveProperty('text');
  });

  it('sends only the start of a long file, and says so', async () => {
    await writeFile(join(project, 'big.log'), 'x'.repeat(MAX_VIEW_BYTES + 10));
    const view = await read(SESSION, 'big.log');
    expect(view.kind).toBe('text');
    if (view.kind !== 'text') return;
    expect(view.text).toHaveLength(MAX_VIEW_BYTES);
    expect(view.truncated).toBe(true);
    expect(view.size).toBe(MAX_VIEW_BYTES + 10);
  });

  it('reads nothing it would not have linked', async () => {
    for (const path of [join(outside, 'secret.txt'), 'escape.txt', 'vault/token.json', 'missing.md', 42, '']) {
      expect(await read(SESSION, path)).toMatchObject({ kind: 'error' });
    }
    expect(await read('other', 'notes.md')).toMatchObject({ kind: 'error' });
    expect(await read('../../etc', 'notes.md')).toMatchObject({ kind: 'error' });
  });
});
