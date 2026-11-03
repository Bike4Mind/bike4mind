import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.platform === 'win32')('runGh', () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), 'b4m-gh-'));
  });

  afterEach(async () => {
    vi.doUnmock('../chat/tools/userPath');
    await rm(directory, { recursive: true, force: true });
  });

  const usePath = async (path: string): Promise<typeof import('./gh')> => {
    const actual = await vi.importActual<typeof import('../chat/tools/userPath')>('../chat/tools/userPath');
    vi.doMock('../chat/tools/userPath', () => ({ ...actual, resolveUserPath: async () => path }));
    return import('./gh');
  };

  it('runs the gh from an absolute PATH folder, never one in the project folder', async () => {
    const project = join(directory, 'project');
    const bin = join(directory, 'bin');
    await mkdir(project);
    await mkdir(bin);
    await writeFile(join(project, 'gh'), '#!/bin/sh\nprintf project\n', { mode: 0o755 });
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nprintf installed\n', { mode: 0o755 });
    const { runGh } = await usePath(`.:${bin}`);

    expect(await runGh(['pr', 'list'], { cwd: project })).toBe('installed');
  });

  it('reports gh as missing when no absolute PATH folder has it', async () => {
    const project = join(directory, 'project');
    await mkdir(project);
    await writeFile(join(project, 'gh'), '#!/bin/sh\nprintf project\n', { mode: 0o755 });
    const { runGh, GhError } = await usePath('.');

    const failure = await runGh(['pr', 'list'], { cwd: project }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GhError);
    expect(failure).toMatchObject({ kind: 'missing', message: 'gh is not installed' });
  });
});
