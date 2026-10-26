import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from '../chat/AttachmentStore';
import { SessionStore } from '../chat/SessionStore';
import {
  codeSessionId,
  countsFor,
  importTranscript,
  listTranscripts,
  claudeWorktreeOf,
  CODE_MAP_VERSION,
  matchesFilter,
  needsImport,
  peekTranscript,
  projectFor,
  type IndexedTranscript,
} from './ClaudeCodeSync';
import { mapToolCall } from './claudeCodeMapper';
import type { FileCursor } from './ImportStateStore';

const FIXTURES = join(__dirname, '__fixtures__');
const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
const WORKTREE = '/work/example-project/.claude/worktrees/sample';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cc-import-'));
  const projects = join(root, 'projects');
  const projectDir = join(projects, '-work-example-project');
  await mkdir(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${SOURCE_ID}.jsonl`);
  await copyFile(join(FIXTURES, 'code-session.jsonl'), transcriptPath);
  const store = new SessionStore(join(root, 'sessions'), 'default-model');
  const attachments = new AttachmentStore(join(root, 'attachments'), { debug: () => {}, warn: () => {} });
  const deps = {
    store,
    pickModel: async () => 'picked-model',
    directoryExists: async () => false,
    storeAttachments: async (
      sessionId: string,
      pending: { messageId: string; name: string; mediaType: string; data: Buffer }[]
    ) => {
      const out = new Map();
      for (const item of pending) {
        const result = await attachments.add(sessionId, [
          { source: 'bytes', name: item.name, mediaType: item.mediaType, data: item.data },
        ]);
        out.set(item.messageId, result.attachments);
      }
      return out;
    },
  };
  return { root, projects, projectDir, transcriptPath, store, deps };
}

async function indexed(path: string): Promise<IndexedTranscript> {
  const info = await stat(path);
  return {
    path,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sourceId: SOURCE_ID,
    sessionId: codeSessionId(SOURCE_ID),
  };
}

async function existingProject(root: string, transcriptPath: string) {
  const repository = join(root, 'repository');
  const worktree = join(repository, '.claude', 'worktrees', 'sample');
  await mkdir(worktree, { recursive: true });
  const transcript = await readFile(transcriptPath, 'utf8');
  await writeFile(transcriptPath, transcript.replaceAll('/work/example-project', repository));
  return { repository, worktree };
}

/** The fixture with its torn last line completed, plus the turns that came after. */
async function completeAndAppend(path: string): Promise<void> {
  const original = await readFile(path, 'utf8');
  const complete = original.slice(0, original.lastIndexOf('\n') + 1);
  await writeFile(path, complete + (await readFile(join(FIXTURES, 'code-session-append.jsonl'), 'utf8')));
}

describe('Claude Code import', () => {
  it('maps a transcript: rounds, tool cards, titles, project and the skipped events', async () => {
    const { transcriptPath, store, deps } = await setup();
    const cursor = await importTranscript(await indexed(transcriptPath), undefined, deps);
    expect(cursor.status).toBe('imported');

    const session = (await store.get(codeSessionId(SOURCE_ID)))!;
    expect(session.title).toBe('Sample listing session');
    expect(session.mode).toBe('code');
    expect(session.model).toBe('picked-model');
    // The folder does not exist here, so the session is left unbound rather than pointed at nothing.
    expect(session.project).toBeUndefined();
    expect(session.importOrigin).toMatchObject({
      kind: 'claude-code',
      sourceId: SOURCE_ID,
      cwd: WORKTREE,
      gitBranch: 'feature/sample',
    });
    expect(session.createdAt).toBe('2026-01-02T10:00:00.000Z');

    const users = session.messages.filter(message => message.role === 'user');
    expect(users.map(message => message.content)).toEqual([
      'Please list the files in the sample project.',
      '/review src',
      'What is in this picture?',
    ]);
    // Sidechain turns belong to a subagent, the meta caveat is not the user talking.
    expect(JSON.stringify(session.messages)).not.toContain('Sidechain');
    expect(JSON.stringify(session.messages)).not.toContain('Caveat');

    const reply = session.messages[1];
    expect(reply.role).toBe('assistant');
    expect(reply.content).toBe('Let me look.\n\nThe project has a README and a src folder.');
    expect(reply.thinking).toBeUndefined();
    expect(reply.rounds).toEqual([
      { text: 'Let me look.', toolCallIds: ['toolu_one'], reasoning: 'I should look at the folder first.' },
      { text: '', toolCallIds: ['toolu_two'] },
      { text: 'The project has a README and a src folder.', toolCallIds: [] },
    ]);
    expect(reply.toolCalls).toEqual([
      {
        id: 'toolu_one',
        name: 'bash_execute',
        input: { command: 'ls', description: 'List files' },
        status: 'done',
        preview: 'README.md\nsrc',
      },
      {
        id: 'toolu_two',
        name: 'file_read',
        input: { path: '/work/example-project/missing.md' },
        status: 'error',
        error: 'File does not exist.',
      },
    ]);
    expect(session.messages.every(message => message.id.startsWith('cc-'))).toBe(true);

    const pictured = session.messages.find(message => message.content === 'What is in this picture?')!;
    expect(pictured.attachments).toHaveLength(1);
    expect(pictured.attachments![0]).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    // The torn last line is not consumed, so the reply it held is not here yet.
    expect(session.messages.at(-1)!.role).toBe('user');
    expect(cursor.offset).toBeLessThan((await stat(transcriptPath)).size);
  });

  it('rebuilds a copy an older mapping made, even when the transcript has not changed', async () => {
    const { root, transcriptPath, store, deps } = await setup();
    const { repository, worktree } = await existingProject(root, transcriptPath);
    const exists = { ...deps, directoryExists: async () => true };
    const first = await importTranscript(await indexed(transcriptPath), undefined, exists);
    const old = { ...first, mapVersion: undefined };
    await store.putImported({
      ...(await store.get(codeSessionId(SOURCE_ID)))!,
      project: { ...(await store.get(codeSessionId(SOURCE_ID)))!.project!, directory: worktree, name: 'sample' },
    });

    expect(needsImport(await indexed(transcriptPath), old)).toBe(true);
    const rebuilt = await importTranscript(await indexed(transcriptPath), old, exists);
    expect(rebuilt.mapVersion).toBe(CODE_MAP_VERSION);
    const session = (await store.get(codeSessionId(SOURCE_ID)))!;
    expect(session.project?.directory).toBe(repository);
    const ids = session.messages.map(message => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps syncing a session after its worktree is removed', async () => {
    const { root, transcriptPath, store, deps } = await setup();
    const { repository, worktree } = await existingProject(root, transcriptPath);
    const onDisk = {
      ...deps,
      directoryExists: async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
    };
    const first = await importTranscript(await indexed(transcriptPath), undefined, onDisk);
    expect((await store.get(codeSessionId(SOURCE_ID)))!.project?.workingDirectory).toBe(worktree);

    await rm(worktree, { recursive: true });
    const old = { ...first, mapVersion: undefined };
    const rebuilt = await importTranscript(await indexed(transcriptPath), old, onDisk);
    expect(rebuilt.status).toBe('imported');
    expect(needsImport(await indexed(transcriptPath), rebuilt)).toBe(false);
    expect((await store.get(codeSessionId(SOURCE_ID)))!.project).toMatchObject({
      directory: repository,
      workspace: false,
      workingDirectory: repository,
    });
  });

  it('appends only what was added since the last read', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    const before = (await store.get(codeSessionId(SOURCE_ID)))!.messages.length;

    await completeAndAppend(transcriptPath);
    const transcript = await indexed(transcriptPath);
    expect(needsImport(transcript, first)).toBe(true);
    const second = await importTranscript(transcript, first, deps);
    expect(second.status).toBe('imported');
    expect(second.offset).toBe(transcript.size);

    const session = (await store.get(codeSessionId(SOURCE_ID)))!;
    const added = session.messages.slice(before);
    expect(added.map(message => [message.role, message.content])).toEqual([
      ['assistant', 'It is a single pixel.'],
      ['user', 'Thanks, now check the tests.'],
      ['assistant', ''],
    ]);
    expect(added[2].toolCalls).toEqual([
      {
        id: 'toolu_three',
        name: 'grep_search',
        input: { pattern: 'describe', path: '/work/example-project' },
        status: 'done',
        preview: 'src/a.test.ts',
      },
    ]);
    // Nothing earlier was duplicated by the second read.
    expect(new Set(session.messages.map(message => message.id)).size).toBe(session.messages.length);
    expect(needsImport(transcript, second)).toBe(false);
  });

  it('leaves a torn last line alone until the file changes, and then writes nothing new for it', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    expect(needsImport(await indexed(transcriptPath), first)).toBe(false);

    const later = new Date('2026-02-01T00:00:00.000Z');
    await utimes(transcriptPath, later, later);
    const put = vi.spyOn(store, 'putImported');
    const touched = await importTranscript(await indexed(transcriptPath), first, deps);
    expect(put).not.toHaveBeenCalled();
    expect(touched).toMatchObject({ offset: first.offset, mtimeMs: later.getTime(), status: 'imported' });
  });

  it('gives the same rounds whether a sync lands between two lines of one API message or not', async () => {
    const { projectDir, store, deps } = await setup();
    const event = (uuid: string, type: string, message: unknown) =>
      JSON.stringify({ type, uuid, sessionId: SOURCE_ID, timestamp: '2026-01-02T10:00:00.000Z', message }) + '\n';
    const head =
      event('u1', 'user', { role: 'user', content: 'Run it.' }) +
      event('a1', 'assistant', {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      }) +
      event('u2', 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] }) +
      event('a2', 'assistant', {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 's' }],
      });
    const tail = event('a3', 'assistant', { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] });

    const path = join(projectDir, `${SOURCE_ID}.jsonl`);
    await writeFile(path, head);
    const first = await importTranscript(await indexed(path), undefined, deps);
    await appendFile(path, tail);
    await importTranscript(await indexed(path), first, deps);
    const incremental = (await store.get(codeSessionId(SOURCE_ID)))!.messages.at(-1)!.rounds;

    await store.delete(codeSessionId(SOURCE_ID));
    await importTranscript(await indexed(path), undefined, deps);
    const fresh = (await store.get(codeSessionId(SOURCE_ID)))!.messages.at(-1)!.rounds;
    expect(incremental).toEqual(fresh);
    expect(fresh!.map(round => round.text)).toEqual(['', 'Done.']);
  });

  it('rebuilds rather than resumes a file rewritten under the cursor', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    const original = await readFile(transcriptPath, 'utf8');
    // Same bytes shifted by one: the cursor now points mid-line.
    await writeFile(transcriptPath, ' ' + original);
    const second = await importTranscript(await indexed(transcriptPath), first, deps);
    expect(second.status).toBe('imported');
    const ids = (await store.get(codeSessionId(SOURCE_ID)))!.messages.map(message => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops syncing a session once it is continued here, and never overwrites the desktop turn', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    const id = codeSessionId(SOURCE_ID);
    await store.appendMessage(id, {
      id: 'desktop-turn',
      role: 'user',
      content: 'Carry on here',
      createdAt: new Date().toISOString(),
    });
    expect((await store.get(id))!.importOrigin!.forkedAt).toBeTruthy();

    await completeAndAppend(transcriptPath);
    const second = await importTranscript(await indexed(transcriptPath), first, deps);
    expect(second.status).toBe('forked');
    const session = (await store.get(id))!;
    expect(session.messages.at(-1)!.content).toBe('Carry on here');
    expect(JSON.stringify(session.messages)).not.toContain('Thanks, now check the tests.');
    expect(needsImport(await indexed(transcriptPath), second)).toBe(false);
  });

  it('does not bring back a session the user deleted', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    await store.delete(codeSessionId(SOURCE_ID));
    await completeAndAppend(transcriptPath);
    const second = await importTranscript(await indexed(transcriptPath), first, deps);
    expect(second.status).toBe('removed');
    expect(await store.get(codeSessionId(SOURCE_ID))).toBeNull();
  });

  it('files the session under its repository, running in its own worktree while that is still there', async () => {
    const { root, transcriptPath, store, deps } = await setup();
    const { repository, worktree } = await existingProject(root, transcriptPath);
    await importTranscript(await indexed(transcriptPath), undefined, { ...deps, directoryExists: async () => true });
    expect((await store.get(codeSessionId(SOURCE_ID)))!.project).toEqual({
      directory: repository,
      name: 'repository',
      branch: 'feature/sample',
      workspace: true,
      workspaceBranch: 'feature/sample',
      workingDirectory: worktree,
      contextDirectories: [],
    });

    const repositoryOnly = async (path: string) => path === repository;
    expect(await projectFor(worktree, 'feature/sample', repositoryOnly)).toMatchObject({
      directory: repository,
      workspace: false,
      workingDirectory: repository,
    });
  });

  it('syncs only sessions that ran in a .claude/worktrees worktree', () => {
    const all = { enabled: true, sourceFolder: null, projects: 'all' as const, includeSubagents: false };
    expect(claudeWorktreeOf('/r/.claude/worktrees/a/apps/web')).toEqual({
      repository: '/r',
      worktree: '/r/.claude/worktrees/a',
    });
    expect(matchesFilter('/r/.claude/worktrees/a', all)).toBe(true);
    expect(matchesFilter('/r/.manifold/worktrees/a', all)).toBe(false);
    expect(matchesFilter('/r', all)).toBe(false);
    expect(matchesFilter(undefined, all)).toBe(false);
    expect(matchesFilter('/r/.claude/worktrees/a', { ...all, projects: ['/r'] })).toBe(true);
    expect(matchesFilter('/s/.claude/worktrees/a', { ...all, projects: ['/r'] })).toBe(false);
  });

  it('indexes by stat and a head read, including subagent files only when asked', async () => {
    const { projects, projectDir, transcriptPath } = await setup();
    const subagents = join(projectDir, SOURCE_ID, 'subagents');
    await mkdir(subagents, { recursive: true });
    await writeFile(join(subagents, 'agent-abc123.jsonl'), '');
    await writeFile(join(projectDir, 'notes.txt'), 'ignored');

    expect((await listTranscripts(projects, false)).map(entry => entry.sessionId)).toEqual([`cc-${SOURCE_ID}`]);
    const withAgents = await listTranscripts(projects, true);
    const agentId = `cca-${SOURCE_ID}-abc123`;
    expect(withAgents.map(entry => entry.sessionId).sort()).toEqual([`cc-${SOURCE_ID}`, agentId]);
    expect(withAgents.find(entry => entry.sessionId === agentId)!.parentSourceId).toBe(SOURCE_ID);
    expect(codeSessionId('a'.repeat(40), SOURCE_ID)).toMatch(/^cca-[0-9a-f]{40}$/);

    // A resumed session carries a copy of its parent's subagent files under its own id.
    const resumed = '99999999-2222-4333-8444-555555555555';
    await mkdir(join(projectDir, resumed, 'subagents'), { recursive: true });
    await writeFile(join(projectDir, resumed, 'subagents', 'agent-abc123.jsonl'), '');
    expect((await listTranscripts(projects, true)).map(entry => entry.sessionId).sort()).toEqual([
      `cc-${SOURCE_ID}`,
      agentId,
      `cca-${resumed}-abc123`,
    ]);

    const peeked = await peekTranscript(await indexed(transcriptPath));
    expect(peeked.cwd).toBe(WORKTREE);
  });

  it('counts by status within the project filter', () => {
    const transcripts = ['a', 'b', 'c', 'd', 'e'].map(name => ({
      path: name,
      size: 1,
      mtimeMs: 1,
      sourceId: name,
      sessionId: name,
    }));
    const cursor = (status: FileCursor['status'], cwd: string): FileCursor => ({
      sessionId: 'x',
      size: 1,
      mtimeMs: 1,
      offset: 1,
      status,
      cwd,
    });
    const files = {
      a: cursor('imported', '/p/.claude/worktrees/one'),
      b: cursor('forked', '/p/.claude/worktrees/two'),
      c: cursor('failed', '/p/.claude/worktrees/one'),
      d: cursor('imported', '/q/.claude/worktrees/one'),
      e: cursor('imported', '/p/.manifold/worktrees/one'),
    };
    expect(
      countsFor(files, transcripts, { enabled: true, sourceFolder: null, projects: ['/p'], includeSubagents: false })
    ).toEqual({
      found: 3,
      imported: 2,
      skipped: 0,
      failed: 1,
      forked: 1,
    });
  });

  it('renames Claude Code tools onto the desktop cards and keeps unknown ones as they are', () => {
    expect(mapToolCall('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).toEqual({
      name: 'file_edit',
      input: { path: '/a', oldText: 'x', newText: 'y' },
    });
    expect(mapToolCall('mcp__server__tool', { q: 1 })).toEqual({ name: 'mcp__server__tool', input: { q: 1 } });
    expect(mapToolCall('Agent', 'not an object')).toEqual({ name: 'Agent', input: {} });
  });
  it('keeps a deletion made while an import is waiting on project resolution', async () => {
    const { transcriptPath, store, deps } = await setup();
    const first = await importTranscript(await indexed(transcriptPath), undefined, deps);
    await completeAndAppend(transcriptPath);
    const id = codeSessionId(SOURCE_ID);
    let resolveReached!: () => void;
    const reached = new Promise<void>(resolve => {
      resolveReached = resolve;
    });
    let releaseProject!: () => void;
    const projectReady = new Promise<void>(resolve => {
      releaseProject = resolve;
    });
    const running = importTranscript(await indexed(transcriptPath), first, {
      ...deps,
      directoryExists: async () => {
        resolveReached();
        await projectReady;
        return false;
      },
    });
    await reached;
    await store.delete(id);
    releaseProject();
    expect((await running).status).toBe('removed');
    expect(await store.get(id)).toBeNull();
  });

  it('retries an unchanged transcript after a failed import', async () => {
    const { transcriptPath } = await setup();
    const transcript = await indexed(transcriptPath);
    const failed: FileCursor = {
      sessionId: transcript.sessionId,
      size: transcript.size,
      mtimeMs: transcript.mtimeMs,
      offset: 0,
      status: 'failed',
      error: 'Temporary I/O error',
    };
    expect(needsImport(transcript, failed)).toBe(true);
  });
});
