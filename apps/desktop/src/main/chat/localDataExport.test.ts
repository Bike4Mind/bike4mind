import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import { MediaStore } from './media/MediaStore';
import { AttachmentStore } from './AttachmentStore';
import { writeLocalDataExport } from './localDataExport';
import { projectSlug } from './project/memory';

const date = '2026-10-01T00:00:00.000Z';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'desktop-local-export-'));
  const userData = join(base, 'userData');
  const destination = join(base, 'destination');
  const memoryRoot = join(base, 'instructions');
  const project = join(base, 'project');
  await Promise.all([mkdir(userData), mkdir(destination), mkdir(project)]);
  const attachments = new AttachmentStore(join(userData, 'attachments'), { debug: vi.fn(), warn: vi.fn() });
  const media = new MediaStore(join(userData, 'media'));
  const image = await media.save('session-1', Buffer.from('image'), 'image/png');
  const attachment = (
    await attachments.add('session-1', [
      { source: 'bytes', name: 'notes.txt', data: Buffer.from('hello'), mediaType: 'text/plain' },
    ])
  ).attachments[0];
  const memoryDirectory = join(memoryRoot, 'projects', projectSlug(project), 'memory');
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(join(memoryDirectory, 'MEMORY.md'), '- [Test](test.md)\n');
  await writeFile(join(memoryDirectory, 'test.md'), 'a memory');
  await writeFile(join(userData, 'auth-vault.json'), 'VAULT_SECRET');
  await writeFile(join(userData, 'mcp-servers.json'), 'MCP_SECRET');
  const session = {
    id: 'session-1',
    title: 'Test',
    model: 'model',
    createdAt: date,
    updatedAt: date,
    mode: 'code',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    project: {
      directory: project,
      workingDirectory: project,
      name: 'project',
      branch: '',
      workspace: false,
      contextDirectories: [],
    },
    messages: [
      { id: 'user-1', role: 'user', content: 'hello', createdAt: date, attachments: [attachment] },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'reply',
        createdAt: date,
        toolCalls: [
          {
            id: 'call-1',
            name: 'generate_image',
            status: 'done',
            input: { token: 'TOOL_INPUT_SECRET' },
            media: [
              {
                kind: 'image',
                url: image.url,
                caption: 'image',
                mimeType: image.mimeType,
                byteLength: image.byteLength,
              },
            ],
          },
        ],
      },
    ],
  } as ChatSession;
  const sessions = {
    list: vi.fn(async () => [{ id: session.id }]),
    get: vi.fn(async () => session),
    scopeKey: vi.fn((): string | null => 'account'),
  };
  return { base, userData, destination, memoryRoot, sessions, attachments, media };
}

describe('writeLocalDataExport', () => {
  it('writes a manifest last with sessions, attachment, media and project memory, without private files', async () => {
    const deps = await setup();
    const { path } = await writeLocalDataExport(deps.destination, deps);
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ exportVersion: '2.0.0', platform: 'bike4mind' });
    expect(manifest.collections.notebooks.count).toBe(1);
    expect(manifest.collections['chat-messages'].count).toBe(2);
    expect(manifest.collections.knowledge.count).toBe(1);
    expect(manifest.collections.media.count).toBe(1);
    expect(manifest.collections.memory.count).toBe(2);
    for (const [name, collection] of Object.entries(manifest.collections)) {
      const entry = collection as { path: string; count: number; bytes: number; sha256: string };
      expect(entry.path).toBe(`collections/${name}.jsonl`);
      const bytes = await readFile(join(path, entry.path));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      expect(bytes.toString('utf8').trim().split('\n').filter(Boolean)).toHaveLength(entry.count);
    }
    const entries = await readdir(path);
    expect(entries).toEqual(['collections', 'files', 'manifest.json']);
    const sessionRow = JSON.parse((await readFile(join(path, 'collections/desktop-sessions.jsonl'), 'utf8')).trim());
    expect(sessionRow.session.messages[1].toolCalls[0].input).toEqual({});
    expect(sessionRow.session.messages[1].toolCalls[0].preview).toBeUndefined();
    expect(sessionRow.session.messages[1].toolCalls[0].media[0].url).toMatch(/^b4m-media:/);
    for (const file of manifest.files) {
      const bytes = await readFile(join(path, file.path));
      expect(bytes).toHaveLength(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    const all = [
      JSON.stringify(manifest),
      ...(await Promise.all(
        Object.values(manifest.collections).map(async value =>
          readFile(join(path, (value as { path: string }).path), 'utf8')
        )
      )),
    ].join('\n');
    expect(all).not.toMatch(/VAULT_SECRET|MCP_SECRET|TOOL_INPUT_SECRET/);
  });

  it('refuses userData and its descendants, including symlink aliases', async () => {
    const deps = await setup();
    await mkdir(join(deps.userData, 'exports'));
    const alias = join(deps.base, 'alias');
    await symlink(deps.userData, alias);
    for (const folder of [deps.userData, join(deps.userData, 'exports'), alias]) {
      await expect(writeLocalDataExport(folder, deps)).rejects.toThrow('outside the app data directory');
    }
    expect((await writeLocalDataExport(deps.base, deps)).path).toContain('bike4mind-export-');
  });

  it('requires a scope and removes incomplete bundles on failure', async () => {
    const deps = await setup();
    deps.sessions.scopeKey.mockReturnValueOnce(null);
    await expect(writeLocalDataExport(deps.destination, deps)).rejects.toThrow('Choose an account');
    deps.attachments.locate = vi.fn(async () => null);
    await expect(writeLocalDataExport(deps.destination, deps)).rejects.toThrow('Missing attachment');
    expect(await readdir(deps.destination)).toEqual([]);
  });

  it('skips a project memory directory linked outside the instructions root', async () => {
    const deps = await setup();
    const outside = join(deps.base, 'outside-memory');
    await mkdir(outside);
    await writeFile(join(outside, 'MEMORY.md'), 'OUTSIDE_SECRET');
    const memory = join(deps.memoryRoot, 'projects', projectSlug(join(deps.base, 'project')), 'memory');
    await rename(memory, `${memory}.old`);
    await symlink(outside, memory);
    const { path, warnings } = await writeLocalDataExport(deps.destination, deps);
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    expect(manifest.collections.memory.count).toBe(0);
    expect(manifest.warnings).toHaveLength(1);
    expect(warnings).toEqual(manifest.warnings);
    const names = [...(await readdir(join(path, 'collections'))).map(n => `collections/${n}`), 'manifest.json'];
    names.push(...(await readdir(join(path, 'files'))).map(n => `files/${n}`));
    for (const name of names) expect((await readFile(join(path, name))).toString('latin1')).not.toContain('OUTSIDE_SECRET');
  });
});
