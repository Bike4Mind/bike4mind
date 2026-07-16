import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createFreshSession,
  resumeSession,
  compactSession,
  rewindSession,
  recalculateSessionMetadata,
  type SessionLifecycleContext,
} from './lifecycle';
import { useCliStore } from '../store';
import type { Session, Message, SessionStore } from '../storage';
import type { ReActAgent } from '@bike4mind/agents';
import type { DecisionStore, BlockerStore, ReviewGateStore, TodoStore } from '../tools';

/**
 * Boundary tests for the extracted session lifecycle (issue #228, phase 3). They
 * drive create / resume / compact / rewind with fake stores and a fake agent,
 * asserting the session transitions they produce - no React/Ink render, which is
 * the point of lifting these out of the root component. The active session is
 * read from / written to the real Zustand store (the single source of truth), so
 * each test seeds and resets it directly.
 */

// Logger.initialize touches the filesystem; the transitions under test don't
// depend on its effect, so stub it out.
vi.mock('../utils/Logger', () => ({
  logger: { initialize: vi.fn(async () => undefined), debug: vi.fn() },
}));

const ISO = '2026-01-01T00:00:00.000Z';

function message(role: Message['role'], content: string, overrides: Partial<Message> = {}): Message {
  return { id: `${role}-${content}`, role, content, timestamp: ISO, ...overrides };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test session',
    createdAt: ISO,
    updatedAt: ISO,
    model: 'claude-sonnet-4-6',
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SessionLifecycleContext> = {}): SessionLifecycleContext {
  // Each fake implements only the slice the lifecycle touches. Keeping `base`
  // typed as SessionLifecycleContext (not casting the whole object) means a new
  // required field on the interface fails this test until a fake exists.
  const base: SessionLifecycleContext = {
    agent: { run: vi.fn(async () => ({ finalAnswer: 'summary text' })) } as unknown as ReActAgent,
    sessionStore: {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
    } as unknown as SessionStore,
    checkpointStore: { setSessionId: vi.fn() } as unknown as SessionLifecycleContext['checkpointStore'],
    defaultModel: undefined,
    contextContent: '',
    decisionStore: { decisions: [] } as DecisionStore,
    blockerStore: { blockers: [] } as BlockerStore,
    reviewGateStore: { reviewGates: [] } as ReviewGateStore,
    todoStore: { todos: [] } as TodoStore,
    onSessionReplaced: vi.fn(),
    drainReviewGatePrompt: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe('session lifecycle', () => {
  beforeEach(() => {
    useCliStore.setState({
      session: null,
      pendingMessages: [],
      messageQueue: [],
      isThinking: false,
      reviewGatePrompt: null,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recalculateSessionMetadata', () => {
    it('sums token usage and counts observation steps across messages', () => {
      const messages: Message[] = [
        message('user', 'hi'),
        message('assistant', 'a', {
          metadata: {
            tokenUsage: { prompt: 0, completion: 0, total: 30 },
            cost: 0.5,
            steps: [
              { type: 'observation', content: 'tool', metadata: { timestamp: 0 } },
              { type: 'thought', content: 'think', metadata: { timestamp: 0 } },
            ],
          },
        }),
        message('assistant', 'b', {
          metadata: { tokenUsage: { prompt: 0, completion: 0, total: 12 }, steps: [] },
        }),
      ];

      expect(recalculateSessionMetadata(messages)).toEqual({
        totalTokens: 42,
        totalCost: 0.5,
        toolCallCount: 1,
      });
    });
  });

  describe('createFreshSession', () => {
    it('installs an empty session, inheriting the current model, and resets workflow stores', async () => {
      useCliStore
        .getState()
        .setSession(makeSession({ id: 'old', model: 'claude-opus-4-8', messages: [message('user', 'x')] }));
      const decisionStore = { decisions: [{ id: 'd1' }] } as unknown as DecisionStore;
      const blockerStore = { blockers: [{ id: 'b1' }] } as unknown as BlockerStore;
      const todoStore = { todos: [{ description: 'stale', status: 'in_progress' }] } as unknown as TodoStore;
      const onSessionReplaced = vi.fn();
      const ctx = makeCtx({ decisionStore, blockerStore, todoStore, onSessionReplaced });

      const created = await createFreshSession(ctx);

      expect(created.messages).toHaveLength(0);
      expect(created.model).toBe('claude-opus-4-8'); // inherited from prior session
      expect(created.id).not.toBe('old'); // fresh uuid when not pinned
      expect(useCliStore.getState().session).toBe(created);
      expect(decisionStore.decisions).toEqual([]);
      expect(blockerStore.blockers).toEqual([]);
      // Todos are never persisted; a session switch must clear them so a prior
      // session's todos cannot bleed into the new session's offline handoff.
      expect(todoStore.todos).toEqual([]);
      expect(ctx.checkpointStore!.setSessionId).toHaveBeenCalledWith(created.id);
      expect(onSessionReplaced).toHaveBeenCalledOnce();
    });

    it('drains a stale review-gate prompt and clears the gate store after the resolve microtask', async () => {
      useCliStore.getState().setSession(makeSession());
      const resolve = vi.fn();
      useCliStore.setState({
        reviewGatePrompt: { id: 'gate-1', description: 'approve?', resolve },
      });
      const reviewGateStore = { reviewGates: [{ id: 'g1' }] } as unknown as ReviewGateStore;
      const drainReviewGatePrompt = vi.fn();
      const ctx = makeCtx({ reviewGateStore, drainReviewGatePrompt });

      await createFreshSession(ctx);
      // Flush the deferred reviewGates reset (queued as a microtask so it lands
      // after the drained gate's resolve continuation).
      await Promise.resolve();

      // The stale gate is drained from the UI queue and rejected so the agent unwinds.
      expect(drainReviewGatePrompt).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith({ decision: 'rejected', note: 'Session cleared.' });
      expect(reviewGateStore.reviewGates).toEqual([]);
    });

    it('falls back to the configured default model when there is no current session', async () => {
      const created = await createFreshSession(makeCtx({ defaultModel: 'claude-haiku-4-5-20251001' }));
      expect(created.model).toBe('claude-haiku-4-5-20251001');
    });

    it('preserves the session id in pinned-session mode', async () => {
      const prev = process.env.B4M_SESSION_ID;
      process.env.B4M_SESSION_ID = 'pinned-123';
      try {
        useCliStore.getState().setSession(makeSession({ id: 'pinned-123' }));
        const created = await createFreshSession(makeCtx());
        expect(created.id).toBe('pinned-123');
      } finally {
        if (prev === undefined) delete process.env.B4M_SESSION_ID;
        else process.env.B4M_SESSION_ID = prev;
      }
    });
  });

  describe('resumeSession', () => {
    it('loads the selected session from disk and installs it', async () => {
      const stored = makeSession({ id: 'saved-1', name: 'saved', messages: [message('user', 'earlier')] });
      const load = vi.fn(async () => stored);
      const ctx = makeCtx({ sessionStore: { load, save: vi.fn() } as unknown as SessionStore });

      const result = await resumeSession(ctx, makeSession({ id: 'saved-1' }));

      expect(load).toHaveBeenCalledWith('saved-1');
      expect(result).toEqual(stored);
      expect(useCliStore.getState().session).toEqual(stored);
      expect(ctx.checkpointStore!.setSessionId).toHaveBeenCalledWith('saved-1');
      expect(ctx.onSessionReplaced).toHaveBeenCalledOnce();
    });

    it('injects the handoff as a leading message when the loaded session has one', async () => {
      const stored = makeSession({
        id: 'saved-1',
        messages: [message('user', 'earlier')],
        metadata: {
          totalTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          workflow: {
            decisions: [],
            blockers: [],
            handoff: {
              summary: 'pick up where we left off',
              keyFindings: [],
              nextSteps: [],
              pendingDecisions: [],
              blockers: [],
              generatedAt: ISO,
            },
          },
        },
      });
      const ctx = makeCtx({
        sessionStore: { load: vi.fn(async () => stored), save: vi.fn() } as unknown as SessionStore,
      });

      const result = await resumeSession(ctx, makeSession({ id: 'saved-1' }));

      const installed = useCliStore.getState().session!;
      expect(installed.messages).toHaveLength(2); // handoff message prepended to the original one
      expect(installed.messages[0].role).toBe('user');
      expect(installed.messages[0].content).toContain('pick up where we left off');
      expect(result).toBe(installed);
    });

    it('returns null and leaves the store untouched when the load fails', async () => {
      const current = makeSession({ id: 'current' });
      useCliStore.getState().setSession(current);
      const ctx = makeCtx({
        sessionStore: { load: vi.fn(async () => null), save: vi.fn() } as unknown as SessionStore,
      });

      const result = await resumeSession(ctx, makeSession({ id: 'missing' }));

      expect(result).toBeNull();
      expect(useCliStore.getState().session).toBe(current);
      expect(ctx.onSessionReplaced).not.toHaveBeenCalled();
    });
  });

  describe('compactSession', () => {
    it('is a no-op when there is no active session', async () => {
      const run = vi.fn();
      await compactSession(makeCtx({ agent: { run } as unknown as ReActAgent }));
      expect(run).not.toHaveBeenCalled();
    });

    it('is a no-op when there are too few messages to compact', async () => {
      useCliStore.getState().setSession(makeSession({ messages: [message('user', 'a'), message('assistant', 'b')] }));
      const run = vi.fn();
      await compactSession(makeCtx({ agent: { run } as unknown as ReActAgent }));
      expect(run).not.toHaveBeenCalled();
    });

    it('summarizes and installs a compacted session, preserving the old one to disk', async () => {
      const messages: Message[] = [
        message('user', 'u1'),
        message('assistant', 'a1'),
        message('user', 'u2'),
        message('assistant', 'a2'),
        message('user', 'u3'),
        message('assistant', 'a3'),
      ];
      const original = makeSession({ messages });
      useCliStore.getState().setSession(original);
      const run = vi.fn(async () => ({ finalAnswer: 'the summary' }));
      const save = vi.fn(async () => undefined);
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionStore: { save, load: vi.fn() } as unknown as SessionStore,
      });

      await compactSession(ctx, { userInstructions: 'focus on X' });

      expect(run).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith(original); // old session preserved first
      const compacted = useCliStore.getState().session!;
      expect(compacted.id).not.toBe(original.id);
      expect(compacted.messages[0].content).toContain('the summary');
      // default preserves the last 2 exchanges (4 messages) verbatim after the summary
      expect(compacted.messages).toHaveLength(5);
      expect(useCliStore.getState().isThinking).toBe(false);
      // Compact swaps the active session, so the usage cache must be invalidated
      // too - matching create/resume (issue #602).
      expect(ctx.onSessionReplaced).toHaveBeenCalledOnce();
    });
  });

  describe('rewindSession', () => {
    it('truncates to before the selected message, recalculates metadata, and returns the prefill', async () => {
      const messages: Message[] = [
        message('user', 'first'),
        message('assistant', 'reply', {
          metadata: { tokenUsage: { prompt: 0, completion: 0, total: 20 }, steps: [] },
        }),
        message('user', 'second'),
        message('assistant', 'reply2', {
          metadata: { tokenUsage: { prompt: 0, completion: 0, total: 50 }, steps: [] },
        }),
      ];
      useCliStore
        .getState()
        .setSession(makeSession({ messages, metadata: { totalTokens: 70, totalCost: 0, toolCallCount: 0 } }));
      const save = vi.fn(async () => undefined);
      const ctx = makeCtx({ sessionStore: { save, load: vi.fn() } as unknown as SessionStore });

      const result = await rewindSession(ctx, 2); // drop from the second user message on

      expect(result).toEqual({ prefill: 'second' });
      const session = useCliStore.getState().session!;
      expect(session.messages).toHaveLength(2);
      expect(session.metadata.totalTokens).toBe(20); // recomputed from the survivors
      expect(save).toHaveBeenCalledWith(session);
    });

    it('returns null when there is no active session', async () => {
      const result = await rewindSession(makeCtx(), 1);
      expect(result).toBeNull();
    });

    it('still returns the prefill when persisting the rewind fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      useCliStore.getState().setSession(
        makeSession({
          messages: [message('user', 'first'), message('assistant', 'reply'), message('user', 'second')],
        })
      );
      const save = vi.fn(async () => {
        throw new Error('disk full');
      });
      const ctx = makeCtx({ sessionStore: { save, load: vi.fn() } as unknown as SessionStore });

      const result = await rewindSession(ctx, 2);

      // Save rejected, but the caller must still get the prefill so the user's
      // message survives in the input (regression guard for the extraction).
      expect(result).toEqual({ prefill: 'second' });
      expect(useCliStore.getState().session!.messages).toHaveLength(2);
    });
  });
});
