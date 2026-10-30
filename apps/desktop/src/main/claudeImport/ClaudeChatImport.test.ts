import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../chat/SessionStore';
import { buildZip } from './__fixtures__/buildZip';
import { chatSessionId, importChatExport, looksLikeClaudeExport } from './ClaudeChatImport';

const FIXTURES = join(__dirname, '__fixtures__');
const GARDEN = 'aaaaaaaa-0000-4000-8000-000000000001';
const UNTITLED = 'bbbbbbbb-0000-4000-8000-000000000002';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'chat-import-'));
  const store = new SessionStore(join(root, 'sessions'), 'default-model');
  const seen: Record<string, string> = {};
  const stored: { sessionId: string; names: string[] }[] = [];
  const deps = {
    store,
    seen,
    pickModel: async () => 'picked-model',
    storeAttachments: async (sessionId: string, pending: { messageId: string; name: string }[]) => {
      stored.push({ sessionId, names: pending.map(item => item.name) });
      return new Map(
        pending.map(item => [
          item.messageId,
          [
            {
              id: 'att1',
              kind: 'text' as const,
              name: item.name,
              mediaType: 'text/plain',
              byteSize: 1,
              sourceBytes: 1,
            },
          ],
        ])
      );
    },
  };
  return { root, store, seen, stored, deps };
}

async function exportZip(
  root: string,
  conversations: Buffer,
  extra: { name: string; data: Buffer }[] = []
): Promise<string> {
  const path = join(root, 'data-export.zip');
  await writeFile(
    path,
    buildZip([
      { name: 'users.json', data: Buffer.from('[]') },
      { name: 'conversations.json', data: conversations },
      ...extra,
    ])
  );
  return path;
}

describe('Claude chat export import', () => {
  it('imports conversations from an export zip and maps their messages', async () => {
    const { root, store, deps, stored } = await setup();
    const path = await exportZip(root, await readFile(join(FIXTURES, 'conversations.json')));
    expect(await looksLikeClaudeExport(path)).toBe(true);

    const summary = await importChatExport(path, deps);
    expect(summary.error).toBeUndefined();
    expect(summary.counts).toEqual({ found: 4, imported: 2, updated: 0, unchanged: 0, skipped: 1, failed: 1 });

    const garden = (await store.get(chatSessionId(GARDEN)))!;
    expect(garden.title).toBe('Planning a garden');
    expect(garden.mode).toBe('chat');
    expect(garden.importOrigin).toMatchObject({
      kind: 'claude-chat',
      sourceId: GARDEN,
      sourceUpdatedAt: '2025-12-01T09:05:00.000Z',
    });
    const [prompt, reply] = garden.messages;
    expect(prompt.content).toBe(
      'Which vegetables grow well in shade? \u00e9\u00e8 \u{1F955}\n\n[Files not included in the export: photo.jpg]'
    );
    expect(prompt.attachments?.map(attachment => attachment.name)).toEqual(['notes.txt']);
    expect(stored).toEqual([{ sessionId: chatSessionId(GARDEN), names: ['notes.txt'] }]);
    expect(reply.content).toBe('Leafy greens such as lettuce [and] spinach {do} well.\n\nSources agree.');
    expect(reply.rounds).toEqual([
      {
        text: 'Leafy greens such as lettuce [and] spinach {do} well.',
        toolCallIds: [`${reply.id}-t2`],
        reasoning: 'Leafy greens tolerate shade.',
      },
      { text: 'Sources agree.', toolCallIds: [] },
    ]);
    expect(reply.toolCalls).toEqual([
      {
        id: `${reply.id}-t2`,
        name: 'web_search',
        input: { query: 'shade vegetables' },
        status: 'done',
        preview: 'result one',
      },
    ]);

    // No name: titled from the first prompt.
    expect((await store.get(chatSessionId(UNTITLED)))!.title).toBe(
      'Untitled question about "quotes" and \\ backslashes'
    );
  });

  it('dedupes a re-import by uuid and updates only conversations that changed', async () => {
    const { root, store, deps } = await setup();
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
    const path = join(root, 'conversations.json');
    await writeFile(path, JSON.stringify(fixture));
    await importChatExport(path, deps);

    fixture[0].updated_at = '2025-12-05T10:00:00.000000Z';
    fixture[0].chat_messages.push({
      uuid: 'dddddddd-0000-4000-8000-000000000003',
      text: 'And in full sun?',
      content: [{ type: 'text', text: 'And in full sun?' }],
      sender: 'human',
      created_at: '2025-12-05T10:00:00.000000Z',
      attachments: [],
      files: [],
    });
    await writeFile(path, JSON.stringify(fixture));
    const second = await importChatExport(path, deps);
    expect(second.counts).toMatchObject({ found: 4, imported: 0, updated: 1, unchanged: 1 });
    const garden = (await store.get(chatSessionId(GARDEN)))!;
    expect(garden.messages.at(-1)!.content).toBe('And in full sun?');
    expect(garden.messages).toHaveLength(3);
    expect((await store.list()).filter(session => session.importOrigin?.kind === 'claude-chat')).toHaveLength(2);
  });

  it('leaves a conversation the user continued here alone on re-import', async () => {
    const { root, store, deps } = await setup();
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
    const path = join(root, 'conversations.json');
    await writeFile(path, JSON.stringify(fixture));
    await importChatExport(path, deps);
    await store.appendMessage(chatSessionId(GARDEN), {
      id: 'mine',
      role: 'user',
      content: 'My own follow-up',
      createdAt: new Date().toISOString(),
    });

    fixture[0].updated_at = '2025-12-09T10:00:00.000000Z';
    fixture[0].name = 'Renamed upstream';
    await writeFile(path, JSON.stringify(fixture));
    const second = await importChatExport(path, deps);
    expect(second.counts.skipped).toBe(2);
    const garden = (await store.get(chatSessionId(GARDEN)))!;
    expect(garden.title).toBe('Planning a garden');
    expect(garden.messages.at(-1)!.content).toBe('My own follow-up');
  });

  it('does not bring back a conversation deleted here, and does not re-store kept attachments', async () => {
    const { root, store, deps, stored } = await setup();
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
    const path = join(root, 'conversations.json');
    await writeFile(path, JSON.stringify(fixture));
    await importChatExport(path, deps);
    await store.delete(chatSessionId(UNTITLED));

    fixture[0].updated_at = '2025-12-05T10:00:00.000000Z';
    fixture[0].name = 'Planning a bigger garden';
    await writeFile(path, JSON.stringify(fixture));
    const second = await importChatExport(path, deps);
    expect(second.counts).toMatchObject({ updated: 1, skipped: 2 });
    expect(await store.get(chatSessionId(UNTITLED))).toBeNull();
    expect(stored).toHaveLength(1);
    const garden = (await store.get(chatSessionId(GARDEN)))!;
    expect(garden.messages[0].attachments?.map(attachment => attachment.name)).toEqual(['notes.txt']);
  });

  it('does not recreate a conversation deleted after its update was read', async () => {
    const { root, store, deps } = await setup();
    const fixture = JSON.parse(await readFile(join(FIXTURES, 'conversations.json'), 'utf8'));
    const path = join(root, 'conversations.json');
    await writeFile(path, JSON.stringify([fixture[0]]));
    await importChatExport(path, deps);
    fixture[0].updated_at = '2025-12-09T10:00:00Z';
    await writeFile(path, JSON.stringify([fixture[0]]));
    const original = store.putImported.bind(store);
    vi.spyOn(store, 'putImported').mockImplementationOnce(async (session, scopeKey, options) => {
      await store.delete(session.id);
      return original(session, scopeKey, options);
    });
    expect((await importChatExport(path, deps)).counts.skipped).toBe(1);
    expect(await store.get(chatSessionId(GARDEN))).toBeNull();
    expect((await importChatExport(path, deps)).counts.skipped).toBe(1);
    expect(await store.get(chatSessionId(GARDEN))).toBeNull();
  });

  it('refuses archives with traversal names, with no conversations.json, or past the size limit', async () => {
    const { root, deps } = await setup();
    const traversal = join(root, 'traversal.zip');
    await writeFile(
      traversal,
      buildZip([
        { name: 'conversations.json', data: Buffer.from('[]') },
        { name: '../../outside.json', data: Buffer.from('{}') },
      ])
    );
    expect((await importChatExport(traversal, deps)).error).toMatch(/unsafe file name/);

    const other = join(root, 'other.zip');
    await writeFile(other, buildZip([{ name: 'photos/a.json', data: Buffer.from('[]') }]));
    expect(await looksLikeClaudeExport(other)).toBe(false);
    expect((await importChatExport(other, deps)).error).toMatch(/no conversations.json/);

    const bomb = join(root, 'bomb.zip');
    await writeFile(bomb, buildZip([{ name: 'conversations.json', data: Buffer.from('[]'), claimedSize: 0xfffffff0 }]));
    expect((await importChatExport(bomb, deps)).error).toMatch(/limit|zip64/);
  });

  it('reads conversations.json from one folder down, never anything deeper', async () => {
    const { root, deps } = await setup();
    const nested = join(root, 'nested.zip');
    const conversations = await readFile(join(FIXTURES, 'conversations.json'));
    await writeFile(nested, buildZip([{ name: 'export/conversations.json', data: conversations }]));
    expect((await importChatExport(nested, deps)).counts.imported).toBe(2);

    const deep = join(root, 'deep.zip');
    await writeFile(deep, buildZip([{ name: 'a/b/conversations.json', data: conversations }]));
    expect((await importChatExport(deep, deps)).error).toMatch(/no conversations.json/);
  });
});
