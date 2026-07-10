import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTurn, type TurnContext } from './turnController';
import { useCliStore } from '../store';
import type { Session, Message, CliConfig, SessionStore, ConfigStore, CommandHistoryStore } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, AgentStep } from '@bike4mind/agents';

/**
 * Boundary tests for the extracted turn lifecycle (issue #228, phase 2). They
 * drive `runTurn` with a fake agent and fake stores, asserting the session
 * transitions it produces - no React/Ink render, which is the whole point of
 * lifting the turn out of the root component. The active session is read from
 * / written to the real Zustand store (the single source of truth), so each
 * test seeds and resets it directly.
 */

const ISO = '2026-01-01T00:00:00.000Z';

function observation(content: string): AgentStep {
  return { type: 'observation', content, metadata: { timestamp: 0 } };
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    finalAnswer: 'agent reply',
    steps: [],
    completionInfo: {
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCredits: 0,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  // Each fake implements only the slice runTurn touches, cast per-field.
  // Keeping `base` typed as TurnContext (not casting the whole object) means a
  // new required field on the interface fails this test until a fake exists.
  const base: TurnContext = {
    agent: { run: vi.fn(async () => makeResult()) } as unknown as ReActAgent,
    sessionStore: { save: vi.fn(async () => undefined) } as unknown as SessionStore,
    configStore: {
      get: vi.fn(async () => ({ preferences: { enableParallelToolExecution: false } })),
    } as unknown as ConfigStore,
    commandHistoryStore: {
      add: vi.fn(async () => undefined),
      list: vi.fn(async () => [] as string[]),
    } as unknown as CommandHistoryStore,
    customCommandStore: { getAllCommands: vi.fn(() => []) } as unknown as CustomCommandStore,
    messageBuilder: null,
    // autoCompact off keeps the compaction branch out of these transition tests.
    config: { preferences: { autoCompact: false } } as unknown as CliConfig,
    availableModels: undefined,
    agentStore: null,
    contextContent: '',
    additionalDirectories: [],
    featureRegistry: null,
    backgroundManager: null,
    setCommandHistory: vi.fn(),
    setAbortController: vi.fn(),
  };
  return { ...base, ...overrides };
}

function seedSession(messages: Message[] = []): Session {
  const session: Session = {
    id: 'sess-1',
    name: 'test session',
    createdAt: ISO,
    updatedAt: ISO,
    model: 'claude-sonnet-4-6',
    messages,
    metadata: { totalTokens: 10, totalCost: 0, totalCredits: 2, toolCallCount: 1 },
  };
  useCliStore.getState().setSession(session);
  return session;
}

describe('runTurn', () => {
  beforeEach(() => {
    useCliStore.setState({ session: null, pendingMessages: [], messageQueue: [], isThinking: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends the user message and the agent reply, and updates session metadata', async () => {
    seedSession([]);
    const run = vi.fn(async (_query: unknown, _options?: unknown) =>
      makeResult({
        finalAnswer: 'done',
        steps: [observation('tool a'), observation('tool b')],
        completionInfo: {
          totalTokens: 100,
          totalInputTokens: 60,
          totalOutputTokens: 40,
          totalCredits: 5,
          iterations: 1,
          toolCalls: 2,
          reachedMaxIterations: false,
        },
      })
    );
    const save = vi.fn(async (_session: Session) => undefined);
    const ctx = makeCtx({
      agent: { run } as unknown as ReActAgent,
      sessionStore: { save } as unknown as SessionStore,
    });

    await runTurn('hello', ctx);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe('hello');

    const session = useCliStore.getState().session;
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(session!.messages[1]).toMatchObject({ role: 'assistant', content: 'done' });

    // metadata accumulates onto the pre-turn baseline (10 tokens / 1 call / 2 credits)
    expect(session!.metadata.totalTokens).toBe(110);
    expect(session!.metadata.toolCallCount).toBe(3);
    expect(session!.metadata.totalCredits).toBe(7);

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({ id: 'sess-1', metadata: { totalTokens: 110 } });
  });

  it('publishes an abort controller for the turn and clears it when the turn settles', async () => {
    seedSession([]);
    const setAbortController = vi.fn((_controller: AbortController | null) => {});
    await runTurn('hi', makeCtx({ setAbortController }));

    expect(setAbortController).toHaveBeenCalledTimes(2);
    expect(setAbortController.mock.calls[0][0]).toBeInstanceOf(AbortController);
    expect(setAbortController.mock.calls[1][0]).toBeNull();
    expect(useCliStore.getState().isThinking).toBe(false);
  });

  it('is a no-op when the agent is not initialized', async () => {
    seedSession([]);
    await runTurn('hi', makeCtx({ agent: null }));
    expect(useCliStore.getState().session!.messages).toHaveLength(0);
  });

  it('is a no-op when there is no active session', async () => {
    const run = vi.fn(async () => makeResult());
    await runTurn('hi', makeCtx({ agent: { run } as unknown as ReActAgent }));
    expect(run).not.toHaveBeenCalled();
  });

  it('records a cancellation message when the agent run is aborted', async () => {
    seedSession([]);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const run = vi.fn(async () => {
      throw abortError;
    });
    const save = vi.fn(async () => undefined);
    const ctx = makeCtx({
      agent: { run } as unknown as ReActAgent,
      sessionStore: { save } as unknown as SessionStore,
    });

    await runTurn('do it', ctx);

    const session = useCliStore.getState().session;
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[1]).toMatchObject({ role: 'assistant', metadata: { cancelled: true } });
    expect(save).toHaveBeenCalledOnce();
    expect(useCliStore.getState().pendingMessages).toHaveLength(0);
  });

  it('surfaces a transient network drop without recording an assistant message', async () => {
    seedSession([]);
    const run = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await runTurn('x', makeCtx({ agent: { run } as unknown as ReActAgent }));

    const session = useCliStore.getState().session;
    // Only the user message lands; the turn is resumable via "continue".
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0].role).toBe('user');
    expect(useCliStore.getState().pendingMessages).toHaveLength(0);
  });

  it('handles an authentication failure without recording an assistant message', async () => {
    seedSession([]);
    const run = vi.fn(async () => {
      throw new Error('Authentication failed: token expired');
    });
    await runTurn('x', makeCtx({ agent: { run } as unknown as ReActAgent }));

    const session = useCliStore.getState().session;
    // Only the user message lands; the user is directed to /login, not shown a stack trace.
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0].role).toBe('user');
    expect(useCliStore.getState().pendingMessages).toHaveLength(0);
    expect(useCliStore.getState().isThinking).toBe(false);
  });

  it('drains queued messages into a follow-up turn after the current one settles', async () => {
    seedSession([]);
    const run = vi.fn(async (_query: unknown, _options?: unknown) => makeResult());
    const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });

    // A message submitted while the first turn was in flight.
    useCliStore.getState().enqueueMessage('second');
    await runTurn('first', ctx);

    // The drain is deferred via setImmediate, so wait for the follow-up run.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[0][0]).toBe('first');
    expect(run.mock.calls[1][0]).toBe('second');
  });
});
