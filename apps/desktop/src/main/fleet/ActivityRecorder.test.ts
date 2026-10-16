import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import type { ActivityEvent } from './activityContract';
import { ActivityRecorder } from './ActivityRecorder';
import { parseRemote } from './repository';

const SESSION = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-10-16T12:00:00.000Z');

function setup(
  enabled = true,
  repository: { owner: string; name: string } | null = { owner: 'acme', name: 'app' },
  model: string | null = 'claude-opus-5'
) {
  let now = T0;
  let n = 0;
  const recorded: ActivityEvent[] = [];
  const recorder = new ActivityRecorder({
    enabled: () => enabled,
    record: events => recorded.push(...events),
    repositoryFor: vi.fn(async () => repository),
    modelFor: vi.fn(async () => model),
    now: () => now,
    newId: () => `event-${String(++n).padStart(4, '0')}`,
  });
  return {
    recorder,
    recorded,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const call = (over: Partial<ChatToolCall>): ChatToolCall =>
  ({
    id: 'call-1',
    name: 'bash_execute',
    input: { command: 'cat secrets.txt' },
    status: 'done',
    ...over,
  }) as ChatToolCall;

const ev = (event: Record<string, unknown>) =>
  ({ sessionId: SESSION, messageId: 'reply-1', ...event }) as ChatStreamEvent;

describe('ActivityRecorder', () => {
  it('turns a reply into session, tool and repository events, metadata only', async () => {
    const { recorder, recorded, advance } = setup();
    recorder.observe(ev({ type: 'start' }));
    recorder.observe(ev({ type: 'tool-end', call: call({ startedAt: T0 + 1000, endedAt: T0 + 4000 }) }));
    recorder.observe(
      ev({
        type: 'tool-end',
        call: call({ id: 'call-2', name: 'file_edit', startedAt: T0 + 5000, endedAt: T0 + 5500 }),
      })
    );
    advance(30_000);
    recorder.observe(ev({ type: 'done', content: 'the reply text' }));
    await vi.waitFor(() => expect(recorded).toHaveLength(4));

    expect(recorded[0]).toEqual({
      eventId: 'event-0001',
      occurredAt: new Date(T0 + 1000).toISOString(),
      durationMs: 3000,
      type: 'tool',
      sessionId: SESSION,
      tool: { type: 'shell' },
    });
    expect(recorded[1]).toMatchObject({ type: 'tool', tool: { type: 'editor' }, durationMs: 500 });
    expect(recorded[2]).toMatchObject({ type: 'session', durationMs: 30_000, occurredAt: new Date(T0).toISOString() });
    expect(recorded[3]).toMatchObject({
      type: 'repository',
      repository: { owner: 'acme', name: 'app', action: 'edit' },
      durationMs: 30_000,
    });
    const wire = JSON.stringify(recorded);
    for (const leaked of ['secrets.txt', 'bash_execute', 'file_edit', 'the reply text'])
      expect(wire).not.toContain(leaked);
  });

  it('marks a reply that changed no files as a view, and skips the repository when there is none', async () => {
    const viewed = setup();
    viewed.recorder.observe(ev({ type: 'start' }));
    viewed.recorder.observe(ev({ type: 'done', content: '' }));
    await vi.waitFor(() => expect(viewed.recorded).toHaveLength(2));
    expect(viewed.recorded[1]).toMatchObject({ repository: { action: 'view' } });

    const none = setup(true, null);
    none.recorder.observe(ev({ type: 'start' }));
    none.recorder.observe(ev({ type: 'error', message: 'boom' }));
    await vi.waitFor(() => expect(none.recorded).toHaveLength(1));
    expect(none.recorded[0].type).toBe('session');
  });

  it('records nothing while disabled, and ignores denied or never-run tools', async () => {
    const off = setup(false);
    off.recorder.observe(ev({ type: 'start' }));
    off.recorder.observe(ev({ type: 'tool-end', call: call({ startedAt: T0, endedAt: T0 + 10 }) }));
    off.recorder.observe(ev({ type: 'done', content: '' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(off.recorded).toEqual([]);

    const on = setup();
    on.recorder.observe(ev({ type: 'tool-end', call: call({ status: 'denied', startedAt: T0, endedAt: T0 + 10 }) }));
    on.recorder.observe(ev({ type: 'tool-end', call: call({ status: 'error' }) }));
    expect(on.recorded).toEqual([]);
  });
});

const usage = (over: Record<string, number> = {}) => ({
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadInputTokens: 5000,
  cacheCreationInputTokens: 40,
  creditsUsed: 265.4,
  usdCost: 0.0123,
  ...over,
});

describe('ActivityRecorder usage', () => {
  it('puts the model, tokens and credits on the session event, counts only', async () => {
    const { recorder, recorded } = setup();
    recorder.observe(ev({ type: 'start' }));
    recorder.observe(ev({ type: 'done', content: 'the reply text', usage: usage() }));
    await vi.waitFor(() => expect(recorded.length).toBeGreaterThan(0));

    expect(recorded[0]).toMatchObject({
      type: 'session',
      usage: {
        model: 'claude-opus-5',
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 40,
        creditsMilli: 265_400,
      },
    });
    expect(Object.keys((recorded[0] as { usage: object }).usage).sort()).toEqual([
      'cacheReadTokens',
      'cacheWriteTokens',
      'creditsMilli',
      'inputTokens',
      'model',
      'outputTokens',
    ]);
    expect(JSON.stringify(recorded)).not.toContain('the reply text');
  });

  it('sends no usage for a reply that reported none, or on a model Fleet cannot key on', async () => {
    const none = setup();
    none.recorder.observe(ev({ type: 'start' }));
    none.recorder.observe(ev({ type: 'done', content: '' }));
    await vi.waitFor(() => expect(none.recorded.length).toBeGreaterThan(0));
    expect(none.recorded[0]).not.toHaveProperty('usage');

    const odd = setup(true, null, 'bad#model');
    odd.recorder.observe(ev({ type: 'start' }));
    odd.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
    await vi.waitFor(() => expect(odd.recorded.length).toBeGreaterThan(0));
    expect(odd.recorded[0]).not.toHaveProperty('usage');

    const unknown = setup(true, null, null);
    unknown.recorder.observe(ev({ type: 'start' }));
    unknown.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
    await vi.waitFor(() => expect(unknown.recorded.length).toBeGreaterThan(0));
    expect(unknown.recorded[0]).not.toHaveProperty('usage');
  });

  it('keeps what a reply spent before it failed', async () => {
    const { recorder, recorded } = setup();
    recorder.observe(ev({ type: 'start' }));
    recorder.observe(ev({ type: 'usage', usage: usage({ creditsUsed: 10 }) }));
    recorder.observe(ev({ type: 'error', message: 'boom' }));
    await vi.waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    expect(recorded[0]).toMatchObject({ usage: { model: 'claude-opus-5', creditsMilli: 10_000 } });
  });

  it('counts a resumed reply once: the second run adds only what is new', async () => {
    const { recorder, recorded } = setup();
    recorder.observe(ev({ type: 'start' }));
    recorder.observe(ev({ type: 'done', content: '', usage: usage({ creditsUsed: 100, inputTokens: 1000 }) }));
    await vi.waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    const first = recorded.length;

    recorder.observe(ev({ type: 'start' }));
    recorder.observe(ev({ type: 'done', content: '', usage: usage({ creditsUsed: 160, inputTokens: 1800 }) }));
    await vi.waitFor(() => expect(recorded.length).toBeGreaterThan(first));

    const sessions = recorded.filter(event => event.type === 'session');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ usage: { creditsMilli: 60_000, inputTokens: 800 } });
  });
});

describe('ActivityRecorder usage, disabled', () => {
  it('reads nothing while sharing is off', async () => {
    const off = setup(false);
    off.recorder.observe(ev({ type: 'start' }));
    off.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(off.recorded).toEqual([]);
  });
});

describe('parseRemote', () => {
  it('keeps only owner and name, whatever the remote form', () => {
    expect(parseRemote('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(parseRemote('https://github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' });
    expect(parseRemote('ssh://git@gitlab.example.test/group/app.git')).toEqual({ owner: 'group', name: 'app' });
    expect(parseRemote('https://token@github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(parseRemote('/local/path')).toBeNull();
    expect(parseRemote('not a remote')).toBeNull();
  });
});
