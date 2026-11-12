import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSessionStatusEvent, ChatSessionSummary, ChatToolCall } from '@shared/chat';
import { STREAM_THROTTLE_MS, WatchService, type WatchSources } from './WatchService';

const T0 = Date.parse('2026-11-12T10:00:00Z');

function session(id: string, parentId: string | null): ChatSessionSummary {
  return {
    id,
    title: `Title ${id}`,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    messageCount: 1,
    ...(parentId ? { origin: { parentSessionId: parentId } } : {}),
  } as ChatSessionSummary;
}

function waitingMessage(approvalId: string, extra: Partial<ChatToolCall> = {}): ChatMessage {
  return {
    id: `m-${approvalId}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: `c-${approvalId}`,
        name: 'bash',
        input: { command: 'ls' },
        status: 'awaiting-approval',
        approvalId,
        ...extra,
      },
    ],
  } as unknown as ChatMessage;
}

function setup(overrides: Partial<WatchSources> = {}) {
  let sessions = [session('root', null), session('a', 'root')];
  const messages = new Map<string, ChatMessage[]>();
  const resolveApproval = vi.fn();
  const warn = vi.fn();
  const service = new WatchService({
    listSessions: async () => sessions,
    sessionStatuses: () => [],
    sessionMessages: async id => messages.get(id) ?? [],
    resolveApproval,
    warn,
    now: () => T0,
    ...overrides,
  });
  const status = async (sessionId: string, value: ChatSessionStatusEvent['status']) => {
    service.observeStatus({ sessionId, status: value });
    await service.settled();
  };
  return {
    service,
    messages,
    resolveApproval,
    warn,
    status,
    setSessions: (next: ChatSessionSummary[]) => {
      sessions = next;
    },
  };
}

describe('WatchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an agent waiting on an approval, with the call to answer', async () => {
    const { service, messages, status } = setup();
    const listener = vi.fn();
    service.onChange(listener);
    messages.set('a', [waitingMessage('approval-1')]);
    await status('a', 'needs-action');

    const snapshot = service.snapshot();
    expect(snapshot.overall).toBe('needs-you');
    expect(snapshot.needsYouCount).toBe(1);
    expect(snapshot.pending).toEqual([
      expect.objectContaining({ approvalId: 'approval-1', sessionId: 'a', quick: true }),
    ]);
    expect(listener).toHaveBeenLastCalledWith(snapshot);
  });

  it('answers a quick approval through the approval gate, once only', async () => {
    const { service, messages, status, resolveApproval } = setup();
    messages.set('a', [waitingMessage('approval-1')]);
    await status('a', 'needs-action');

    await expect(service.respond('approval-1', 'once')).resolves.toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith('approval-1', { decision: 'once' });
  });

  it('refuses an id that is not pending, or one that needs the full card', async () => {
    const { service, messages, status, resolveApproval } = setup();
    messages.set('a', [waitingMessage('risky', { approvalIrreversible: true })]);
    await status('a', 'needs-action');

    await expect(service.respond('risky', 'once')).resolves.toBe(false);
    await expect(service.respond('answered-in-app', 'deny')).resolves.toBe(false);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it('drops an approval once its session stops waiting', async () => {
    const { service, messages, status } = setup();
    messages.set('a', [waitingMessage('approval-1')]);
    await status('a', 'needs-action');
    await status('a', 'processing');

    expect(service.snapshot().pending).toEqual([]);
    await expect(service.respond('approval-1', 'once')).resolves.toBe(false);
  });

  it('re-reads a waiting session when another call parks, and after an answer', async () => {
    const { service, messages, status } = setup();
    messages.set('a', [waitingMessage('approval-1')]);
    await status('a', 'needs-action');

    messages.set('a', [waitingMessage('approval-1'), waitingMessage('approval-2')]);
    service.observeStream({
      type: 'tool-start',
      sessionId: 'a',
      call: { id: 'c-approval-2', name: 'bash', input: { command: 'ls' }, status: 'awaiting-approval' },
    } as never);
    await service.settled();
    expect(service.snapshot().pending.map(item => item.approvalId)).toEqual(['approval-1', 'approval-2']);

    messages.set('a', [waitingMessage('approval-2')]);
    await service.respond('approval-1', 'once');
    await service.settled();
    expect(service.snapshot().pending.map(item => item.approvalId)).toEqual(['approval-2']);
  });

  it('counts a turn that started and ended before the rebuild ran', async () => {
    const { service } = setup();
    await service.settled();
    service.observeStatus({ sessionId: 'a', status: 'processing' });
    service.observeStatus({ sessionId: 'a', status: 'done' });
    await service.settled();
    expect(service.snapshot().overall).toBe('done');
  });

  it('is done after work finishes, until the user looks', async () => {
    const { service, status } = setup();
    await status('a', 'processing');
    expect(service.snapshot().overall).toBe('working');
    await status('a', 'done');
    expect(service.snapshot().overall).toBe('done');
    expect(service.snapshot().orchestrations[0].celebrate).toBe(true);

    service.acknowledge();
    await service.settled();
    expect(service.snapshot().overall).toBe('idle');
  });

  it('never calls an orchestration done that was idle from the start', async () => {
    const { service, status } = setup();
    await status('a', 'done');
    expect(service.snapshot().overall).toBe('idle');
  });

  it('throttles stream activity into one rebuild', async () => {
    const { service, status } = setup();
    await status('a', 'processing');
    const listener = vi.fn();
    service.onChange(listener);
    service.observeStream({ type: 'phase', sessionId: 'a', phase: { kind: 'thinking' } } as never);
    service.observeStream({
      type: 'tool-start',
      sessionId: 'a',
      call: { id: 'c', name: 'read_file', input: { path: 'src/index.ts' }, status: 'running' },
    } as never);
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS);
    await service.settled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.snapshot().orchestrations[0].agents[0].activity).toBe('read_file index.ts');
  });

  it('re-reads everything from the new scope after an account change', async () => {
    const { service, messages, status, setSessions } = setup();
    messages.set('a', [waitingMessage('approval-1')]);
    await status('a', 'needs-action');

    setSessions([]);
    service.scopeChanged();
    await service.settled();
    expect(service.snapshot().orchestrations).toEqual([]);
    expect(service.snapshot().overall).toBe('idle');
  });

  it('seeds statuses that were set before it started', async () => {
    const { service } = setup({ sessionStatuses: () => [{ sessionId: 'a', status: 'processing' }] });
    service.start();
    await service.settled();
    expect(service.snapshot().overall).toBe('working');
  });

  it('keeps going after a failed list read', async () => {
    const { service, warn } = setup({ listSessions: () => Promise.reject(new Error('disk')) });
    service.observeStatus({ sessionId: 'a', status: 'processing' });
    await service.settled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk'));
  });
});
