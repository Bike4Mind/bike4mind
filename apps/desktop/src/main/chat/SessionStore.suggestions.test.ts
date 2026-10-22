import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSpawnSuggestion } from '@shared/chat';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

function suggestion(id: string, changes: Partial<ChatSpawnSuggestion> = {}): ChatSpawnSuggestion {
  return {
    id,
    title: id,
    prompt: `task ${id}`,
    base: 'main',
    branch: `agent/${id}`,
    status: 'pending',
    revision: 0,
    createdAt: '2026-10-14T00:00:00.000Z',
    ...changes,
  };
}

describe('SessionStore spawn suggestions', () => {
  let store: SessionStore;
  let sessionId: string;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-store-suggest-')), 'test-model');
    sessionId = (await store.create()).id;
    await store.appendMessage(sessionId, { id: 'm1', role: 'user', content: 'hi', createdAt: 'now' });
  });

  it('reports each outcome onto one message once, then drops what no longer needs showing', async () => {
    await store.changeSpawnSuggestions(sessionId, () => [
      suggestion('a', { status: 'dismissed', dismissedBy: 'user', unreported: true }),
      suggestion('b', {
        status: 'started',
        unreported: true,
        started: { sessionId: 'child', title: 'b', placement: 'local', edited: false },
      }),
      suggestion('c'),
    ]);

    const reported = await store.reportSpawnSuggestions(sessionId, 'm1', entry => `note ${entry.id}`);
    expect(reported?.notes).toEqual(['note a', 'note b']);
    expect(reported?.suggestions.map(entry => entry.id)).toEqual(['b', 'c']);
    expect(reported?.suggestions.some(entry => entry.unreported)).toBe(false);

    expect(await store.reportSpawnSuggestions(sessionId, 'm1', entry => `note ${entry.id}`)).toBeNull();
    expect((await store.get(sessionId))?.messages[0]?.notes).toEqual(['note a', 'note b']);
  });

  it('keeps an outcome unreported when its message is missing', async () => {
    await store.changeSpawnSuggestions(sessionId, () => [suggestion('a', { status: 'dismissed', unreported: true })]);
    expect(await store.reportSpawnSuggestions(sessionId, 'gone', () => 'x')).toBeNull();
    expect((await store.spawnSuggestions(sessionId))[0]?.unreported).toBe(true);
  });

  it('caps reported starts at the newest 20 and never drops a pending one', async () => {
    const started = Array.from({ length: 25 }, (_, index) => suggestion(`s${index}`, { status: 'started' }));
    const after = await store.changeSpawnSuggestions(sessionId, () => [suggestion('p'), ...started]);
    expect(after).toHaveLength(21);
    expect(after?.[0]?.id).toBe('p');
    expect(after?.[1]?.id).toBe('s5');
  });

  it('drops pending suggestions on archive and keeps the started ones', async () => {
    await store.changeSpawnSuggestions(sessionId, () => [suggestion('a'), suggestion('b', { status: 'started' })]);
    await store.setArchived(sessionId, true);
    expect((await store.spawnSuggestions(sessionId)).map(entry => entry.id)).toEqual(['b']);
  });

  it('loses no message when a suggestion write overlaps an append', async () => {
    await Promise.all([
      store.appendMessage(sessionId, { id: 'm2', role: 'assistant', content: 'reply', createdAt: 'now' }),
      store.changeSpawnSuggestions(sessionId, current => [...current, suggestion('a')]),
      store.appendMessage(sessionId, { id: 'm3', role: 'user', content: 'more', createdAt: 'now' }),
    ]);
    const stored = await store.get(sessionId);
    expect(stored?.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(stored?.spawnSuggestions?.map(entry => entry.id)).toEqual(['a']);
  });
});
