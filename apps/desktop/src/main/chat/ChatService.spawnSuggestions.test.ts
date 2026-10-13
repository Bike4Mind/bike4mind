import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSessionSummary, ChatSpawnSuggestion, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };

/**
 * session_spawn with a user present: it suggests and returns, the user starts or dismisses the
 * card whenever they like, and the model hears what they did exactly once.
 */
describe('ChatService spawn suggestions', () => {
  let sessionsDir: string;
  let store: SessionStore;
  let service: ChatService;
  let approvals: ApprovalGate;
  let requested: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-suggest-')));
    sessionsDir = await mkdtemp(join(tmpdir(), 'b4m-suggest-sessions-'));
    store = new SessionStore(sessionsDir, 'test-model');
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    requested = vi.fn<(sessionId: string) => void>();
    approvals = new ApprovalGate({ requested, settled: vi.fn() });

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session;
  }

  function callTool(stream: PassThrough, id: string, name: string, args: Record<string, unknown>): void {
    stream.write(frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(args) }] }));
    stream.write(frame('[DONE]'));
  }

  function reply(stream: PassThrough, text: string): void {
    stream.write(frame({ type: 'content', text }));
    stream.write(frame('[DONE]'));
  }

  function wire(index: number): WireMessage[] {
    return post.mock.calls[index]?.[1]?.messages as WireMessage[];
  }

  /** The newest request whose last message is the user turn `text` (notes may follow it). */
  function requestEndingWith(text: string): number {
    for (let index = post.mock.calls.length - 1; index >= 0; index--) {
      const last = wire(index)?.at(-1);
      if (last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith(text)) return index;
    }
    return -1;
  }

  async function awaitRequestEndingWith(text: string): Promise<number> {
    return vi.waitUntil(
      () => {
        const index = requestEndingWith(text);
        return index >= 0 ? index : undefined;
      },
      { timeout: 5000, interval: 5 }
    );
  }

  function settled(name: string) {
    return events
      .filter(event => event.type === 'tool-end')
      .map(event => (event.type === 'tool-end' ? event.call : null))
      .filter(call => call?.name === name);
  }

  function latestSuggestions(sessionId: string): ChatSpawnSuggestion[] {
    const latest = events.findLast(event => event.type === 'spawn-suggestions' && event.sessionId === sessionId);
    return latest?.type === 'spawn-suggestions' ? latest.suggestions : [];
  }

  function awaitSuggestion(sessionId: string, match: (entry: ChatSpawnSuggestion) => boolean) {
    return vi.waitUntil(() => latestSuggestions(sessionId).find(match), { timeout: 5000, interval: 5 });
  }

  function awaitTurnEnd(sessionId: string, count: number) {
    return vi.waitUntil(
      () => events.filter(event => event.type === 'done' && event.sessionId === sessionId).length >= count,
      { timeout: 5000, interval: 5 }
    );
  }

  /** A parent that has suggested `prompt` and finished its turn, with the suggestion. */
  async function suggestedBy(prompt: string, title = 'Tidy imports') {
    const parent = await codeSession();
    await service.send(parent.id, 'delegate');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    callTool(streams[0], 's1', 'session_spawn', { prompt, title, summary: 'Clean up the imports' });
    const suggestion = await awaitSuggestion(parent.id, entry => entry.status === 'pending');
    // The tool result opens the parent's next round; ending it leaves the parent idle.
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    reply(streams[1], 'I suggested a session for that.');
    await awaitTurnEnd(parent.id, 1);
    return { parent, suggestion };
  }

  it('suggests and returns at once: nothing starts, nothing is asked, and the turn goes on', async () => {
    const { parent, suggestion } = await suggestedBy('remove the unused imports in src/a.ts');

    const call = settled('session_spawn')[0];
    expect(call?.status).toBe('done');
    expect(call?.preview).toContain(`Suggested task ${suggestion.id}`);
    expect(call?.preview).toContain('Nothing has started');
    expect(requested).not.toHaveBeenCalled();
    expect((await store.list()).some(session => session.origin)).toBe(false);

    expect(suggestion).toMatchObject({
      title: 'Tidy imports',
      summary: 'Clean up the imports',
      prompt: 'remove the unused imports in src/a.ts',
      branch: expect.stringContaining('tidy-imports'),
      revision: 0,
    });
    // Persisted with the session, so it survives a relaunch.
    const relaunched = new SessionStore(sessionsDir, 'test-model');
    expect((await relaunched.get(parent.id))?.spawnSuggestions?.[0]?.id).toBe(suggestion.id);
    // But never carried in the sidebar listing.
    expect((await store.list()).find(entry => entry.id === parent.id)).not.toHaveProperty('spawnSuggestions');
  });

  it('lets the model revise a pending suggestion and withdraw one', async () => {
    const { parent, suggestion } = await suggestedBy('remove the unused imports');

    await service.send(parent.id, 'also sort them');
    const turn = streams[await awaitRequestEndingWith('also sort them')];
    callTool(turn, 'u1', 'session_suggestion_update', {
      id: suggestion.id,
      prompt: 'remove and sort the imports',
      title: 'Sort imports',
    });
    const updated = await awaitSuggestion(parent.id, entry => entry.revision === 1);
    expect(updated).toMatchObject({ prompt: 'remove and sort the imports', title: 'Sort imports', status: 'pending' });
    expect(updated.branch).toContain('sort-imports');
    expect(settled('session_suggestion_update')[0]?.status).toBe('done');

    await vi.waitUntil(() => streams.length === 4, { timeout: 5000, interval: 5 });
    callTool(streams[3], 'd1', 'session_suggestion_dismiss', { id: suggestion.id, reason: 'not needed' });
    await vi.waitUntil(() => settled('session_suggestion_dismiss').length === 1, { timeout: 5000, interval: 5 });
    expect(settled('session_suggestion_dismiss')[0]?.status).toBe('done');
    // Withdrawn by the model itself, so there is no outcome to tell it and nothing left to show.
    expect(latestSuggestions(parent.id)).toEqual([]);
    expect((await store.list()).some(session => session.origin)).toBe(false);
  });

  it('refuses to revise a suggestion the user already started', async () => {
    const { parent, suggestion } = await suggestedBy('remove the unused imports');
    const started = await service.startSpawnSuggestion({
      sessionId: parent.id,
      suggestionId: suggestion.id,
      placement: 'local',
      prompt: suggestion.prompt,
      title: suggestion.title,
    });
    expect(started.ok).toBe(true);

    await service.send(parent.id, 'change it');
    callTool(streams[await awaitRequestEndingWith('change it')], 'u1', 'session_suggestion_update', {
      id: suggestion.id,
      prompt: 'something else',
    });
    await vi.waitUntil(() => settled('session_suggestion_update').length === 1, { timeout: 5000, interval: 5 });
    expect(settled('session_suggestion_update')[0]).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/already started/),
    });
  });

  it('tells the model once that the user started an edited suggestion, with the child id', async () => {
    const { parent, suggestion } = await suggestedBy('remove the unused imports');

    const result = await service.startSpawnSuggestion({
      sessionId: parent.id,
      suggestionId: suggestion.id,
      placement: 'local',
      prompt: 'remove the unused imports and run the linter',
      title: suggestion.title,
    });
    if (!result.ok) throw new Error(result.error);
    const childId = result.suggestion.started?.sessionId;
    expect(childId).toBeTruthy();
    expect(result.suggestion.started).toMatchObject({ placement: 'local', edited: true });
    expect((await store.get(childId as string))?.origin?.seedPrompt).toBe(
      'remove the unused imports and run the linter'
    );

    await service.send(parent.id, 'next');
    const first = await awaitRequestEndingWith('next');
    const carried = wire(first).at(-1)?.content as string;
    expect(carried).toMatch(/^next\n\n<system-reminder>/);
    expect(carried).toContain(`The user started suggestion ${suggestion.id}`);
    expect(carried).toContain(childId);
    expect(carried).toContain('They edited it before starting');
    expect(carried).toContain('and run the linter');

    reply(streams[first], 'Noted.');
    await awaitTurnEnd(parent.id, 2);

    await service.send(parent.id, 'and then');
    const second = await awaitRequestEndingWith('and then');
    const mentions = JSON.stringify(wire(second)).split(`The user started suggestion ${suggestion.id}`).length - 1;
    // Replayed on the turn it rode in on, and not added to this one.
    expect(mentions).toBe(1);
    expect(wire(second).at(-1)?.content).toBe('and then');
  });

  it('tells the model once that the user dismissed a suggestion', async () => {
    const { parent, suggestion } = await suggestedBy('remove the unused imports');
    const dismissed = await service.dismissSpawnSuggestion(parent.id, suggestion.id);
    expect(dismissed).toMatchObject({ ok: true, suggestion: { status: 'dismissed', dismissedBy: 'user' } });
    expect(
      await service.startSpawnSuggestion({
        sessionId: parent.id,
        suggestionId: suggestion.id,
        placement: 'local',
        prompt: suggestion.prompt,
        title: suggestion.title,
      })
    ).toMatchObject({ ok: false });

    await service.send(parent.id, 'next');
    const first = await awaitRequestEndingWith('next');
    expect(wire(first).at(-1)?.content).toContain(`The user dismissed suggestion ${suggestion.id}`);
    expect((await store.list()).some(session => session.origin)).toBe(false);
    // Reported, so nothing is left to show or to tell.
    await vi.waitUntil(() => latestSuggestions(parent.id).length === 0, { timeout: 5000, interval: 5 });
  });

  it('starts a suggestion while the conversation is still replying', async () => {
    const parent = await codeSession();
    await service.send(parent.id, 'delegate');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    callTool(streams[0], 's1', 'session_spawn', { prompt: 'do it elsewhere' });
    const suggestion = await awaitSuggestion(parent.id, entry => entry.status === 'pending');
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });

    const result = await service.startSpawnSuggestion({
      sessionId: parent.id,
      suggestionId: suggestion.id,
      placement: 'local',
      prompt: suggestion.prompt,
      title: suggestion.title,
    });
    expect(result.ok).toBe(true);
    expect((await store.list()).filter(session => session.origin)).toHaveLength(1);
  });

  it('drops pending suggestions when the conversation is archived', async () => {
    const { parent } = await suggestedBy('remove the unused imports');
    await service.setSessionArchived(parent.id, true);
    expect((await store.get(parent.id))?.spawnSuggestions).toBeUndefined();
    expect(latestSuggestions(parent.id)).toEqual([]);
  });

  it('keeps the approval-gated start in a spawned session, which has no card to show', async () => {
    const { parent, suggestion } = await suggestedBy('do the child work');
    const result = await service.startSpawnSuggestion({
      sessionId: parent.id,
      suggestionId: suggestion.id,
      placement: 'local',
      prompt: suggestion.prompt,
      title: suggestion.title,
    });
    if (!result.ok) throw new Error(result.error);

    const childRequest = await awaitRequestEndingWith('do the child work');
    const tools = (post.mock.calls[childRequest][1].options.tools as { toolSchema: { name: string } }[]).map(
      entry => entry.toolSchema.name
    );
    expect(tools).toContain('session_spawn');
    expect(tools).not.toContain('session_suggestion_update');

    callTool(streams[childRequest], 'g1', 'session_spawn', { prompt: 'and another' });
    const card = await vi.waitUntil(
      () =>
        events
          .map(event => (event.type === 'tool-start' ? event.call : null))
          .find(call => call?.name === 'session_spawn' && call.status === 'awaiting-approval'),
      { timeout: 5000, interval: 5 }
    );
    expect(card.approvalChoice?.options.map(option => option.id)).toEqual(['worktree', 'local']);
    expect(latestSuggestions(result.suggestion.started?.sessionId as string)).toEqual([]);
  });
});
