import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../chat/AttachmentStore';
import { SessionStore } from '../chat/SessionStore';
import {
  codeSessionId,
  countsFor,
  importTranscript,
  listTranscripts,
  needsImport,
  peekTranscript,
  type IndexedTranscript,
} from './ClaudeCodeSync';
import { mapToolCall } from './claudeCodeMapper';
import type { FileCursor } from './ImportStateStore';

const FIXTURES = join(__dirname, '__fixtures__');
const SOURCE_ID = '11111111-2222-4333-8444-555555555555';

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
      cwd: '/work/example-project',
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

  it('binds the project when the folder exists here', async () => {
    const { transcriptPath, store, deps } = await setup();
    await importTranscript(await indexed(transcriptPath), undefined, { ...deps, directoryExists: async () => true });
    const session = (await store.get(codeSessionId(SOURCE_ID)))!;
    expect(session.project).toEqual({
      directory: '/work/example-project',
      name: 'example-project',
      branch: 'feature/sample',
      workspace: false,
      workingDirectory: '/work/example-project',
      contextDirectories: [],
    });
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
    expect(peeked.cwd).toBe('/work/example-project');
  });

  it('counts by status within the project filter', () => {
    const transcripts = ['a', 'b', 'c', 'd'].map(name => ({
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
      a: cursor('imported', '/p'),
      b: cursor('forked', '/p'),
      c: cursor('failed', '/p'),
      d: cursor('imported', '/q'),
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
});
