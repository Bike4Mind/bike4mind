import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChatProject } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { git } from './git';
import { countUntrackedFile, parseNumstat, readWorkspaceChanges } from './workspaceChanges';

async function repository(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'b4m-changes-')));
  await git(directory, ['init', '--initial-branch=main', '--quiet']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  await writeFile(join(directory, 'README.md'), 'one\ntwo\nthree\n', 'utf8');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '--quiet', '-m', 'first']);
  return directory;
}

async function commitAll(directory: string, message: string): Promise<void> {
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '--quiet', '-m', message]);
}

function worktreeSession(directory: string, over: Partial<ChatProject> = {}): ChatProject {
  return {
    directory,
    name: 'repo',
    branch: 'main',
    workspace: true,
    workspaceBranch: 'b4m/task-abc123',
    workingDirectory: directory,
    contextDirectories: [],
    ...over,
  };
}

describe('parseNumstat', () => {
  it('reads counts, marks binaries, and keeps a path with a tab in it whole', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\0-\t-\tlogo.png\x002\t0\tweird\tname.txt\0')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'logo.png', added: 0, removed: 0, binary: true },
      { path: 'weird\tname.txt', added: 2, removed: 0 },
    ]);
  });

  it('is empty for empty output', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('countUntrackedFile', () => {
  it('counts a final line that has no newline, as git does', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'new.txt'), 'a\nb\nc', 'utf8');

    expect(await countUntrackedFile(directory, 'new.txt')).toEqual({
      file: { path: 'new.txt', added: 3, removed: 0, untracked: true },
      bytesRead: 5,
    });
  });

  it('marks a file with a NUL byte as binary', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'blob.bin'), Buffer.from([1, 0, 2, 10]));

    expect((await countUntrackedFile(directory, 'blob.bin')).file).toMatchObject({ binary: true, added: 0 });
  });

  it('stops at the byte cap rather than reading the whole file', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'big.txt'), 'line\n'.repeat(1000), 'utf8');

    expect(await countUntrackedFile(directory, 'big.txt', 50)).toMatchObject({ file: { added: 10 }, bytesRead: 50 });
  });

  it.skipIf(process.platform === 'win32')('never opens a FIFO, which would block forever', async () => {
    const directory = await repository();
    await promisify(execFile)('mkfifo', [join(directory, 'pipe')]);

    expect(await countUntrackedFile(directory, 'pipe')).toEqual({
      file: { path: 'pipe', added: 0, removed: 0, untracked: true },
      bytesRead: 0,
    });
  });
});

describe('readWorkspaceChanges', () => {
  it('is null with no project, and for a worktree the first turn has not cut yet', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'README.md'), 'dirty\n', 'utf8');

    expect(await readWorkspaceChanges(undefined)).toBeNull();
    expect(await readWorkspaceChanges(worktreeSession(directory, { workspaceBranch: undefined }))).toBeNull();
  });

  it('is null on a branch identical to its base', async () => {
    const directory = await repository();
    await git(directory, ['switch', '--quiet', '-c', 'b4m/task-abc123']);

    expect(await readWorkspaceChanges(worktreeSession(directory))).toBeNull();
  });

  it('adds up committed, staged, unstaged and untracked changes against the base', async () => {
    const directory = await repository();
    await git(directory, ['switch', '--quiet', '-c', 'b4m/task-abc123']);
    await writeFile(join(directory, 'committed.ts'), 'a\nb\n', 'utf8');
    await commitAll(directory, 'session work');
    await writeFile(join(directory, 'README.md'), 'one\nTWO\nthree\n', 'utf8');
    await writeFile(join(directory, 'staged.ts'), 'x\n', 'utf8');
    await git(directory, ['add', 'staged.ts']);
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src', 'untracked.ts'), 'u1\nu2\nu3\n', 'utf8');

    const changes = await readWorkspaceChanges(worktreeSession(directory));

    expect(changes).toEqual({
      base: 'main',
      added: 2 + 1 + 1 + 3,
      removed: 1,
      fileCount: 4,
      files: [
        { path: 'README.md', added: 1, removed: 1 },
        { path: 'committed.ts', added: 2, removed: 0 },
        { path: 'src/untracked.ts', added: 3, removed: 0, untracked: true },
        { path: 'staged.ts', added: 1, removed: 0 },
      ],
      commitsAhead: 1,
      uncommitted: 3,
    });
  });

  it('measures from origin/<base>, so upstream commits a stale local base lacks are not counted', async () => {
    const directory = await repository();
    // Upstream moved on after local `main` was last updated; the worktree was cut from upstream.
    await git(directory, ['switch', '--quiet', '-c', 'upstream']);
    await writeFile(join(directory, 'upstream.ts'), 'u\nu\nu\nu\n', 'utf8');
    await commitAll(directory, 'upstream work');
    await git(directory, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(directory, ['switch', '--quiet', '-c', 'b4m/task-abc123']);
    await writeFile(join(directory, 'mine.ts'), 'm\n', 'utf8');
    await commitAll(directory, 'session work');

    const changes = await readWorkspaceChanges(worktreeSession(directory));

    expect(changes).toMatchObject({ base: 'origin/main', added: 1, removed: 0, fileCount: 1, commitsAhead: 1 });
    expect(changes?.files.map(file => file.path)).toEqual(['mine.ts']);
  });

  it('reports uncommitted edits for an in-place session on the default branch', async () => {
    const directory = await repository();
    await writeFile(join(directory, 'README.md'), 'one\n', 'utf8');

    const changes = await readWorkspaceChanges(
      worktreeSession(directory, { workspace: false, workspaceBranch: undefined })
    );

    expect(changes).toMatchObject({ added: 0, removed: 2, fileCount: 1, commitsAhead: 0, uncommitted: 1 });
  });
});
