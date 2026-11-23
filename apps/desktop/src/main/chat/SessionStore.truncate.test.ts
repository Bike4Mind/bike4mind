import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

const MODEL = 'test-model';
const at = '2026-11-01T00:00:00.000Z';

function message(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: id, createdAt: at, ...extra };
}

async function seeded(messages: ChatMessage[]) {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-truncate-'));
  const store = new SessionStore(directory, MODEL);
  const session = await store.create();
  for (const entry of messages) await store.appendMessage(session.id, entry);
  return { directory, store, id: session.id };
}

describe('SessionStore.truncateFrom', () => {
  it('drops the message and everything after it, with what those turns carried, and persists it', async () => {
    const { directory, store, id } = await seeded([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user', {
        attachments: [{ id: 'att', kind: 'text', name: 'a.txt', mediaType: 'text/plain', byteSize: 1, sourceBytes: 1 }],
      }),
      message('a2', 'assistant', {
        toolCalls: [{ id: 'call', name: 'file_write', input: {}, status: 'done' }],
        artifacts: [{ id: 'art', type: 'html', title: 't', content: '<p/>' } as never],
      }),
    ]);

    const truncated = await store.truncateFrom(id, 'u2');
    expect(truncated && truncated.messages.map(entry => entry.id)).toEqual(['u1', 'a1']);

    const reopened = await new SessionStore(directory, MODEL).get(id);
    expect(reopened?.messages.map(entry => entry.id)).toEqual(['u1', 'a1']);
    expect(reopened?.messages.some(entry => entry.toolCalls || entry.artifacts || entry.attachments)).toBe(false);
  });

  it('takes a /compact marker after the cut with it, so the history before it is live again', async () => {
    const { store, id } = await seeded([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('b', 'user', { boundary: { kind: 'compact' }, content: 'summary' }),
      message('u3', 'user'),
    ]);
    const truncated = await store.truncateFrom(id, 'u2');
    expect(truncated && truncated.messages.some(entry => entry.boundary)).toBe(false);
  });

  it('answers false and writes nothing when the message is gone or admit rejects it', async () => {
    const { store, id } = await seeded([message('u1', 'user'), message('a1', 'assistant')]);
    const before = (await store.get(id))?.updatedAt;

    expect(await store.truncateFrom(id, 'missing')).toBe(false);
    expect(await store.truncateFrom(id, 'a1', entry => entry.role === 'user')).toBe(false);
    const after = await store.get(id);
    expect(after?.messages).toHaveLength(2);
    expect(after?.updatedAt).toBe(before);
  });

  it('answers null for a session that does not exist', async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-truncate-')), MODEL);
    expect(await store.truncateFrom('d4a2c1b0-0000-4000-8000-000000000000', 'u1')).toBeNull();
  });

  it('marks an imported conversation forked, so a later sync cannot overwrite the rewound thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-truncate-'));
    const id = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a34';
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({
        id,
        title: 'imported',
        model: MODEL,
        createdAt: at,
        updatedAt: at,
        mode: 'chat',
        approvalMode: 'ask',
        importOrigin: { kind: 'claude-code', sourceId: 'source', importedAt: at, sourceUpdatedAt: at },
        messages: [message('u1', 'user'), message('a1', 'assistant')],
      }),
      'utf8'
    );
    const store = new SessionStore(directory, MODEL);
    const truncated = await store.truncateFrom(id, 'a1');
    expect(truncated && truncated.importOrigin?.forkedAt).toBeTruthy();
  });
});
