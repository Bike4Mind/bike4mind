import { ToolCatalog } from '../tools/gateway/toolCatalog.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTurn, runPeerTurn, type TurnContext } from './turnController';
import { useCliStore } from '../store';
import { whenTurnIdle } from './whenTurnIdle';
import type { Session, Message, CliConfig, SessionStore, ConfigStore } from '../storage';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, AgentStep } from '@bike4mind/agents';
import type { TodoItem } from '../tools/writeTodosTool.js';
import type { ModelInfo } from '@bike4mind/common';
import { PostEditDiagnostics } from '../diagnostics/PostEditDiagnostics.js';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { getTokenCounter } from '../utils/tokenCounter.js';
import * as processHooks from '../utils/processHooks.js';
import { bridgePresence } from '../features/bridgePresence/index.js';

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

function captureTurnActivity() {
  const fireUserPromptSubmit = vi.fn(async () => {});
  const fireStop = vi.fn(async () => {});
  vi.spyOn(processHooks, 'getProcessHooks').mockReturnValue({
    fireUserPromptSubmit,
    fireStop,
  } as unknown as ReturnType<typeof processHooks.getProcessHooks>);
  const emitEvent = vi.spyOn(bridgePresence, 'emitEvent').mockResolvedValue();
  return { fireUserPromptSubmit, fireStop, emitEvent };
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
    customCommandStore: {
      getAllCommands: vi.fn(() => []),
      getModelReachableCommands: vi.fn(() => []),
    } as unknown as CustomCommandStore,
    messageBuilder: null,
    // autoCompact off keeps the compaction branch out of these transition tests.
    config: { preferences: { autoCompact: false } } as unknown as CliConfig,
    availableModels: undefined,
    agentStore: null,
    contextContent: '',
    additionalDirectories: [],
    featureRegistry: null,
    backgroundManager: null,
    toolCatalog: new ToolCatalog(),
    todoStore: null,
    decisionStore: null,
    blockerStore: null,
    postEditDiagnostics: null,
    workflowStores: {
      decisionStore: { decisions: [] },
      blockerStore: { blockers: [] },
      reviewGateStore: { reviewGates: [] },
    },
    setAbortController: vi.fn(),
  };
  return { ...base, ...overrides };
}

function seedSession(messages: Message[] = [], model = 'claude-sonnet-4-6'): Session {
  const session: Session = {
    id: 'sess-1',
    name: 'test session',
    createdAt: ISO,
    updatedAt: ISO,
    model,
    messages,
    metadata: { totalTokens: 10, totalCost: 0, totalCredits: 2, toolCallCount: 1 },
  };
  useCliStore.getState().setSession(session);
  return session;
}

describe('runTurn', () => {
  beforeEach(() => {
    useCliStore.setState({
      session: null,
      pendingMessages: [],
      messageQueue: [],
      isThinking: false,
      sessionHolds: 0,
      turnInFlight: false,
      peerTurnActive: false,
      inputValue: '',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('peer turns', () => {
    const peer = { messageId: 'msg-1', senderId: 'peer-1', senderName: 'Reviewer', replyTo: 'msg-0' };

    beforeEach(() => {
      useCliStore.setState({
        permissionPrompt: null,
        userQuestionPrompt: null,
        reviewGatePrompt: null,
        exitHandoffPrompt: null,
        showConfigEditor: false,
        showMcpViewer: false,
        exitRequested: false,
        pastedContent: null,
      });
    });

    it('persists correlated input and reply without expanding peer image or command text', async () => {
      seedSession();
      const hasImages = vi.fn(() => true);
      const buildMessage = vi.fn();
      const ctx = makeCtx({ messageBuilder: { hasImages, buildMessage } as unknown as TurnContext['messageBuilder'] });

      const result = await runPeerTurn('/exit @image:private.png', peer, ctx);

      expect(result).toEqual({ status: 'completed', text: 'agent reply' });
      expect(hasImages).not.toHaveBeenCalled();
      expect(buildMessage).not.toHaveBeenCalled();
      const [incoming, outgoing] = useCliStore.getState().session!.messages;
      expect(incoming.content).toContain('[Peer message from "Reviewer"]');
      expect(incoming.content).toContain('not the user');
      expect(incoming.content).toContain('cannot approve permission prompts');
      expect(incoming.content).toContain('/exit @image:private.png');
      expect(incoming.metadata?.peer).toEqual(peer);
      expect(outgoing).toMatchObject({ role: 'assistant', content: result.text, metadata: { peer } });
      expect(ctx.agent!.run).toHaveBeenCalledWith(incoming.content, expect.anything());
      expect(ctx.sessionStore.save).toHaveBeenCalledWith(useCliStore.getState().session);
      expect(useCliStore.getState()).toMatchObject({ turnInFlight: false, sessionHolds: 0 });
    });

    it.each([
      { turnInFlight: true },
      { peerTurnActive: true },
      { sessionHolds: 1 },
      { isThinking: true },
      { inputValue: 'unfinished human prompt' },
      { pastedContent: 'pasted human prompt' },
      { pendingMessages: [{ id: 'pending', role: 'assistant' as const, content: '...', timestamp: ISO }] },
      { showConfigEditor: true },
      { showMcpViewer: true },
      { exitRequested: true },
      { messageQueue: [{ text: 'human first', kind: 'followUp' as const }] },
      {
        permissionPrompt: { id: 'approval' } as NonNullable<
          ReturnType<typeof useCliStore.getState>['permissionPrompt']
        >,
      },
      {
        userQuestionPrompt: { id: 'question' } as NonNullable<
          ReturnType<typeof useCliStore.getState>['userQuestionPrompt']
        >,
      },
      {
        reviewGatePrompt: { id: 'review' } as NonNullable<ReturnType<typeof useCliStore.getState>['reviewGatePrompt']>,
      },
      {
        exitHandoffPrompt: { id: 'exit' } as NonNullable<ReturnType<typeof useCliStore.getState>['exitHandoffPrompt']>,
      },
    ])('rejects busy state without queueing or changing history: %j', async busy => {
      seedSession();
      const onTurnStart = vi.fn();
      const ctx = makeCtx({ onTurnStart });
      useCliStore.setState(busy);
      const queue = useCliStore.getState().messageQueue;

      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'busy' });
      expect(ctx.agent!.run).not.toHaveBeenCalled();
      expect(onTurnStart).not.toHaveBeenCalled();
      expect(useCliStore.getState().messageQueue).toEqual(queue);
      expect(useCliStore.getState().session!.messages).toEqual([]);
    });

    it('claims the turn before an asynchronous operation can admit a second peer', async () => {
      seedSession();
      let finish!: (result: AgentResult) => void;
      const run = vi.fn(
        () =>
          new Promise<AgentResult>(resolve => {
            finish = resolve;
          })
      );
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });
      const first = runPeerTurn('first', peer, ctx);

      expect(await runPeerTurn('second', { ...peer, messageId: 'msg-2' }, ctx)).toEqual({ status: 'busy' });
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      finish(makeResult({ finalAnswer: 'first result' }));
      expect(await first).toEqual({ status: 'completed', text: 'first result' });
    });

    it('returns the peer reply even when a human follow-up starts immediately afterward', async () => {
      seedSession();
      let calls = 0;
      const onTurnStart = vi.fn();
      const run = vi.fn(async (_message: unknown) => {
        if (++calls === 1) {
          useCliStore.getState().enqueueMessage('human follow-up', 'followUp');
          return makeResult({ finalAnswer: 'peer result' });
        }
        return makeResult({ finalAnswer: 'human result' });
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, onTurnStart });

      expect(await runPeerTurn('peer request', peer, ctx)).toEqual({ status: 'completed', text: 'peer result' });
      await vi.waitFor(() => expect(useCliStore.getState().turnInFlight).toBe(false));
      expect(run.mock.calls[1][0]).toBe('human follow-up');
      const messages = useCliStore.getState().session!.messages;
      expect(messages[1].metadata?.peer?.messageId).toBe('msg-1');
      expect(messages[3].metadata?.peer).toBeUndefined();
      expect(onTurnStart).toHaveBeenCalledTimes(2);
      expect(onTurnStart.mock.calls).toEqual([[peer], [undefined]]);
    });

    it('does not expose human steers or expanded file content in the result returned to a peer', async () => {
      seedSession();
      const expandedFile = 'explain @private.txt\n--- Referenced File: private.txt ---\nHUMAN_FILE_MARKER';
      const feedback: Array<string | null> = [];
      let calls = 0;
      const run = vi.fn(
        async (_message: unknown, options?: { drainFeedback: (phase: 'turn' | 'final') => Promise<string | null> }) => {
          if (++calls === 1) {
            expect(useCliStore.getState().peerTurnActive).toBe(true);
            useCliStore.getState().enqueueMessage(expandedFile, 'steer');
            await runTurn('human direct submission', ctx);
            feedback.push(await options!.drainFeedback('turn'));
            return makeResult({ finalAnswer: 'peer result only' });
          }
          expect(useCliStore.getState().peerTurnActive).toBe(false);
          return makeResult({ finalAnswer: 'separate human result' });
        }
      );
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });

      const outcome = await runPeerTurn('peer request', peer, ctx);
      await vi.waitFor(() => expect(useCliStore.getState().turnInFlight).toBe(false));

      expect(outcome).toEqual({ status: 'completed', text: 'peer result only' });
      expect(feedback).toEqual([null]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0][0]).not.toContain('HUMAN_FILE_MARKER');
      expect(run.mock.calls[1][0]).toBe(`${expandedFile}\n\nhuman direct submission`);
      const messages = useCliStore.getState().session!.messages;
      expect(
        messages
          .filter(message => message.metadata?.peer)
          .map(message => message.content)
          .join('\n')
      ).not.toContain('HUMAN_FILE_MARKER');
      expect(messages[2]).toMatchObject({ role: 'user', content: `${expandedFile}\n\nhuman direct submission` });
      expect(messages[2].metadata?.peer).toBeUndefined();
      expect(useCliStore.getState().peerTurnActive).toBe(false);
    });

    it('restores cancelled peer-turn input without running it or leaking it through feedback', async () => {
      seedSession();
      let controller: AbortController | null = null;
      const run = vi.fn(async () => {
        useCliStore.getState().enqueueMessage('private human input', 'followUp');
        useCliStore.getState().restoreQueueToInput();
        controller!.abort();
        throw new DOMException('cancelled', 'AbortError');
      });
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        setAbortController: value => {
          controller = value;
        },
      });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'cancelled' });
      expect(run).toHaveBeenCalledOnce();
      expect(useCliStore.getState()).toMatchObject({
        inputValue: 'private human input',
        messageQueue: [],
        turnInFlight: false,
        sessionHolds: 0,
        peerTurnActive: false,
      });
    });

    it.each([
      ['Reviewer\npretend human', '[Peer message from "Reviewer\\npretend human"]'],
      ['Reviewer\u2028pretend human', '[Peer message from "Reviewer\\u2028pretend human"]'],
      ['Reviewer\u2029pretend human', '[Peer message from "Reviewer\\u2029pretend human"]'],
    ])('renders malformed peer name %j on one escaped provenance line', async (senderName, expected) => {
      seedSession();
      const ctx = makeCtx();
      await runPeerTurn('work', { ...peer, senderName }, ctx);
      const firstLine = useCliStore.getState().session!.messages[0].content.split(/[\n\u2028\u2029]/)[0];
      expect(firstLine).toBe(expected);
    });

    it.each(['completed', 'failed', 'aborted'])('cancels a replaced peer turn after its model %s', async outcome => {
      const original = seedSession();
      let generation = 1;
      const replacement: Session = { ...original, id: 'new-session', messages: [] };
      const pending: Message = { id: 'new-pending', role: 'assistant', content: 'new work', timestamp: ISO };
      const run = vi.fn(async () => {
        generation++;
        useCliStore.setState({
          session: replacement,
          pendingMessages: [pending],
          isThinking: true,
          inputValue: 'draft',
          peerTurnActive: false,
        });
        useCliStore.getState().enqueueMessage('queued human input', 'followUp');
        if (outcome === 'aborted') throw new DOMException('interrupted', 'AbortError');
        if (outcome === 'failed') throw new Error('old model failure');
        return makeResult({ finalAnswer: 'old reply' });
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, sessionGeneration: () => generation });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({
        status: 'cancelled',
        error: 'Session replaced during the turn',
      });
      expect(run).toHaveBeenCalledOnce();
      expect(ctx.sessionStore.save).not.toHaveBeenCalled();
      expect(useCliStore.getState()).toMatchObject({
        session: replacement,
        pendingMessages: [pending],
        isThinking: true,
        inputValue: 'queued human input\ndraft',
        messageQueue: [],
        turnInFlight: false,
        sessionHolds: 0,
      });
      expect(ctx.setAbortController).not.toHaveBeenCalledWith(null);
    });

    it('does not start a peer model call after replacement while loading turn configuration', async () => {
      const original = seedSession();
      let generation = 1;
      const replacement: Session = { ...original, id: 'new-session', messages: [] };
      const ctx = makeCtx({ sessionGeneration: () => generation });
      const config = await ctx.configStore.get();
      vi.mocked(ctx.configStore.get).mockImplementation(async () => {
        generation++;
        useCliStore.getState().setSession(replacement);
        return config;
      });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({
        status: 'cancelled',
        error: 'Session replaced during the turn',
      });
      expect(ctx.agent!.run).not.toHaveBeenCalled();
      expect(ctx.sessionStore.save).not.toHaveBeenCalled();
      expect(useCliStore.getState().session).toBe(replacement);
    });

    it('does not clear a newer generation peer activity flag when an old turn retires', async () => {
      const original = seedSession();
      let generation = 1;
      const run = vi.fn(async () => {
        generation++;
        useCliStore.getState().setSession({ ...original, id: 'new-session', messages: [] });
        useCliStore.setState({ peerTurnActive: true, isThinking: true });
        return makeResult();
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, sessionGeneration: () => generation });

      expect(await runPeerTurn('work', peer, ctx)).toMatchObject({ status: 'cancelled' });
      expect(useCliStore.getState().peerTurnActive).toBe(true);
    });

    it.each([
      ['new ID', 'completed'],
      ['new ID', 'failed'],
      ['new ID', 'aborted'],
      ['pinned ID', 'completed'],
      ['pinned ID', 'failed'],
      ['pinned ID', 'aborted'],
    ])('fences a %s conversation replacement after its old peer model %s', async (kind, outcome) => {
      const original = seedSession();
      let epoch = 1;
      const replacement: Session = {
        ...original,
        id: kind === 'pinned ID' ? original.id : 'new-conversation',
        messages: [],
      };
      const pending: Message = { id: 'new-pending', role: 'assistant', content: 'new work', timestamp: ISO };
      const run = vi.fn(async () => {
        useCliStore.getState().enqueueMessage('queued human input', 'followUp');
        useCliStore.getState().setSession(replacement);
        epoch++;
        useCliStore.setState({ pendingMessages: [pending], isThinking: true, inputValue: 'new draft' });
        expect(useCliStore.getState().peerTurnActive).toBe(true);
        if (outcome === 'failed') throw new Error('late model failure');
        if (outcome === 'aborted') throw new DOMException('interrupted', 'AbortError');
        return makeResult({ finalAnswer: 'late private reply' });
      });
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionGeneration: () => 1,
        peerSessionEpoch: () => epoch,
      });

      expect(await runPeerTurn('old work', peer, ctx)).toEqual({
        status: 'cancelled',
        error: 'Session replaced during the turn',
      });
      expect(run).toHaveBeenCalledOnce();
      expect(ctx.sessionStore.save).not.toHaveBeenCalled();
      expect(ctx.setAbortController).not.toHaveBeenCalledWith(null);
      expect(useCliStore.getState()).toMatchObject({
        session: replacement,
        pendingMessages: [pending],
        inputValue: 'queued human input\nnew draft',
        messageQueue: [],
        isThinking: true,
        turnInFlight: false,
        sessionHolds: 0,
        peerTurnActive: false,
      });
    });

    it('recognizes a new receiving session ID even when its caller does not supply an epoch', async () => {
      const original = seedSession();
      const replacement: Session = { ...original, id: 'new-conversation', messages: [] };
      const run = vi.fn(async () => {
        useCliStore.getState().setSession(replacement);
        return makeResult({ finalAnswer: 'late reply' });
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, sessionGeneration: () => 1 });

      expect(await runPeerTurn('old work', peer, ctx)).toMatchObject({ status: 'cancelled' });
      expect(useCliStore.getState().session).toBe(replacement);
      expect(ctx.sessionStore.save).not.toHaveBeenCalled();
    });

    it('leaves an empty replacement idle after its retiring peer turn settles', async () => {
      const original = seedSession();
      let epoch = 1;
      let finish!: (result: AgentResult) => void;
      const run = vi.fn(
        () =>
          new Promise<AgentResult>(resolve => {
            finish = resolve;
          })
      );
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionGeneration: () => 1,
        peerSessionEpoch: () => epoch,
      });
      const retiring = runPeerTurn('old peer work', peer, ctx);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

      const replacement: Session = { ...original, messages: [] };
      useCliStore.getState().setSession(replacement);
      useCliStore.getState().clearPendingMessages();
      epoch++;
      useCliStore.getState().setIsThinking(false);
      vi.mocked(ctx.setAbortController).mock.calls[0][0]!.abort();
      ctx.setAbortController(null);
      useCliStore.getState().enqueueMessage('fresh human prompt', 'followUp');
      expect(useCliStore.getState()).toMatchObject({ peerTurnActive: true, turnInFlight: true, isThinking: false });

      finish(makeResult({ finalAnswer: 'late old reply' }));
      expect(await retiring).toMatchObject({ status: 'cancelled' });
      expect(useCliStore.getState()).toMatchObject({
        session: replacement,
        pendingMessages: [],
        isThinking: false,
        turnInFlight: false,
        peerTurnActive: false,
        sessionHolds: 0,
        inputValue: 'fresh human prompt',
        messageQueue: [],
      });
      expect(ctx.sessionStore.save).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
      expect(ctx.setAbortController).toHaveBeenCalledTimes(2);
    });

    it.each(['resolved', 'rejected'])(
      'does not publish an old peer result after its save %s during replacement',
      async outcome => {
        const original = seedSession();
        let generation = 1;
        const replacement: Session = { ...original, id: 'new-session', messages: [] };
        const save = vi.fn(async () => {
          generation++;
          useCliStore.getState().setSession(replacement);
          if (outcome === 'rejected') throw new Error('old history failure');
        });
        const ctx = makeCtx({ sessionGeneration: () => generation, sessionStore: { save } as unknown as SessionStore });

        expect(await runPeerTurn('work', peer, ctx)).toEqual({
          status: 'cancelled',
          error: 'Session replaced during the turn',
        });
        expect(ctx.agent!.run).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
        expect(useCliStore.getState().session).toBe(replacement);
      }
    );

    it('persists cancellation with provenance and releases the turn', async () => {
      seedSession();
      const run = vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError');
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'cancelled' });
      expect(useCliStore.getState().session!.messages[1]).toMatchObject({ metadata: { cancelled: true, peer } });
      expect(ctx.sessionStore.save).toHaveBeenCalled();
      expect(useCliStore.getState()).toMatchObject({ turnInFlight: false, sessionHolds: 0 });
    });

    it('persists a failed peer turn and reports its exact failure', async () => {
      seedSession();
      const run = vi.fn(async () => {
        throw new Error('Authentication expired');
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'failed', error: 'Authentication expired' });
      expect(useCliStore.getState().session!.messages[1]).toMatchObject({
        content: 'Peer turn failed: Authentication expired',
        metadata: { peer },
      });
      expect(ctx.sessionStore.save).toHaveBeenCalled();
    });

    it.each(['first', 'permanent'])('retains the exact completed reply after a %s save failure', async failure => {
      seedSession();
      const activity = captureTurnActivity();
      const run = vi.fn(async () => makeResult({ finalAnswer: 'exact peer reply' }));
      const saved: Session[] = [];
      let attempts = 0;
      const save = vi.fn(async (session: Session) => {
        if (++attempts === 1 || failure === 'permanent') throw new Error('History storage unavailable');
        saved.push(structuredClone(session));
      });
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionStore: { save } as unknown as SessionStore,
      });

      const outcome = await runPeerTurn('work', peer, ctx);

      expect(outcome).toEqual({
        status: 'failed',
        text: 'exact peer reply',
        error: 'Model turn finished but session history could not be saved',
      });
      expect(run).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
      const session = useCliStore.getState().session!;
      expect(session.messages).toHaveLength(2);
      expect(new Set(session.messages.map(message => message.id)).size).toBe(session.messages.length);
      expect(session.messages.filter(message => message.role === 'assistant')).toEqual([
        expect.objectContaining({ content: outcome.text, metadata: expect.objectContaining({ peer }) }),
      ]);
      expect(session.messages.some(message => message.content.includes(outcome.error!))).toBe(false);
      expect(useCliStore.getState()).toMatchObject({ turnInFlight: false, sessionHolds: 0, isThinking: false });
      expect(ctx.setAbortController).toHaveBeenLastCalledWith(null);
      expect(activity.fireUserPromptSubmit).not.toHaveBeenCalled();
      expect(activity.fireStop).toHaveBeenCalledOnce();
      expect(activity.emitEvent).toHaveBeenLastCalledWith({ type: 'status', status: 'idle' });
      if (failure === 'first') {
        await ctx.sessionStore.save(session);
        expect(saved).toEqual([session]);
      } else {
        expect(saved).toEqual([]);
      }
      expect(run).toHaveBeenCalledOnce();
    });

    it.each(['permission', 'limit'])('reports %s stops without marking successful completion', async stop => {
      seedSession();
      const result =
        stop === 'permission'
          ? makeResult({ finalAnswer: 'Permission denied for tool bash_execute' })
          : makeResult({ completionInfo: { ...makeResult().completionInfo, reachedMaxIterations: true } });
      const ctx = makeCtx({ agent: { run: vi.fn(async () => result) } as unknown as ReActAgent });

      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'stopped', text: result.finalAnswer });
      expect(useCliStore.getState().session!.messages[1].metadata?.peer).toEqual(peer);
    });

    it('fails closed before initialization', async () => {
      const ctx = makeCtx();
      expect(await runPeerTurn('work', peer, ctx)).toEqual({ status: 'failed', error: 'Session is not initialized' });
      expect(ctx.agent!.run).not.toHaveBeenCalled();
    });

    it('stops before proactive compaction can replace its receiving session or call a model', async () => {
      const activity = captureTurnActivity();
      const onTurnStart = vi.fn();
      const original = seedSession(
        Array.from({ length: 6 }, (_, i) => ({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'history '.repeat(1000),
          timestamp: ISO,
        }))
      );
      const run = vi.fn(async () => makeResult());
      const ctx = makeCtx({
        agent: { run, getTools: () => [] } as unknown as ReActAgent,
        config: { preferences: { autoCompact: true } } as unknown as CliConfig,
        availableModels: [{ id: original.model, contextWindow: 500 } as unknown as ModelInfo],
        onTurnStart,
      });

      expect(await runPeerTurn('peer work', peer, ctx)).toEqual({
        status: 'stopped',
        error:
          'Compact the session manually, enable peers again if needed, and ask the sender to resend the stopped message.',
      });
      expect(run).not.toHaveBeenCalled();
      expect(onTurnStart).not.toHaveBeenCalled();
      expect(activity.fireUserPromptSubmit).not.toHaveBeenCalled();
      expect(activity.fireStop).not.toHaveBeenCalled();
      expect(activity.emitEvent).not.toHaveBeenCalled();
      expect(useCliStore.getState().session!.id).toBe(original.id);
      expect(
        useCliStore
          .getState()
          .session!.messages.slice(-2)
          .map(message => message.metadata?.peer)
      ).toEqual([peer, peer]);
      expect(ctx.sessionStore.save).toHaveBeenCalledOnce();
      expect(useCliStore.getState()).toMatchObject({ turnInFlight: false, sessionHolds: 0, isThinking: false });
    });

    it.each(['human', 'peer'])('balances activity signals for an admitted %s turn', async source => {
      seedSession();
      const activity = captureTurnActivity();
      const onTurnStart = vi.fn();
      const run = vi.fn(async () => {
        expect(activity.fireUserPromptSubmit).toHaveBeenCalledTimes(source === 'human' ? 1 : 0);
        expect(activity.fireStop).not.toHaveBeenCalled();
        expect(activity.emitEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: 'status', status: 'running' })
        );
        expect(useCliStore.getState()).toMatchObject({ turnInFlight: true, sessionHolds: 1, isThinking: true });
        return makeResult();
      });
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, onTurnStart });

      if (source === 'peer') await runPeerTurn('work', peer, ctx);
      else await runTurn('work', ctx);

      const message = useCliStore.getState().session!.messages[0].content;
      expect(onTurnStart).toHaveBeenCalledOnce();
      expect(activity.fireUserPromptSubmit).toHaveBeenCalledTimes(source === 'human' ? 1 : 0);
      expect(activity.fireStop).toHaveBeenCalledOnce();
      expect(activity.emitEvent.mock.calls.map(([event]) => event)).toEqual([
        ...(source === 'human' ? [{ type: 'message', role: 'user', text: message.slice(0, 4000) }] : []),
        { type: 'status', status: 'running', text: message.slice(0, 240) },
        { type: 'status', status: source === 'human' ? 'awaiting_input' : 'idle' },
      ]);
      expect(ctx.setAbortController).toHaveBeenLastCalledWith(null);
      expect(useCliStore.getState()).toMatchObject({ turnInFlight: false, sessionHolds: 0, isThinking: false });
    });
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

  it('persists durable workflow state logged during the turn onto the saved session', async () => {
    seedSession([]);
    const save = vi.fn(async (_session: Session) => undefined);
    // Simulate a decision logged into the store mid-turn (as log_decision would).
    const decision = {
      id: 'd1',
      timestamp: ISO,
      summary: 'adopt discriminated unions',
      rationale: 'model state safely',
    };
    const ctx = makeCtx({
      sessionStore: { save } as unknown as SessionStore,
      workflowStores: {
        decisionStore: { decisions: [decision] },
        blockerStore: { blockers: [] },
        reviewGateStore: { reviewGates: [] },
      },
    });

    await runTurn('hello', ctx);

    // Without the sync, workflow state would live only in the in-memory store
    // and be lost to a later auto-compaction that reads session.metadata.
    expect(save.mock.calls[0][0].metadata.workflow?.decisions).toEqual([decision]);
    expect(useCliStore.getState().session!.metadata.workflow?.decisions).toEqual([decision]);
  });

  it('leaves workflow metadata unset when no durable state was logged', async () => {
    seedSession([]);
    const save = vi.fn(async (_session: Session) => undefined);
    await runTurn('hello', makeCtx({ sessionStore: { save } as unknown as SessionStore }));

    expect(save.mock.calls[0][0].metadata.workflow).toBeUndefined();
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

  it('holds the session until it settles, so a mid-turn append lands after it instead of being clobbered', async () => {
    seedSession([]);
    const appended: Message = { id: 'bang', role: 'assistant', content: 'shell output', timestamp: ISO };
    const run = vi.fn(async () => {
      // A `!command` finishing mid-turn, after ESC already cleared the spinner.
      useCliStore.getState().setIsThinking(false);
      whenTurnIdle(() => {
        const session = useCliStore.getState().session!;
        useCliStore.getState().setSession({ ...session, messages: [...session.messages, appended] });
      });
      return makeResult({ finalAnswer: 'reply' });
    });

    await runTurn('hi', makeCtx({ agent: { run } as unknown as ReActAgent }));

    const contents = useCliStore.getState().session!.messages.map(message => message.content);
    expect(contents).toEqual(['hi', 'reply', 'shell output']);
    expect(useCliStore.getState().sessionHolds).toBe(0);
  });

  it('takes its hold before reading the session, so an append during the turn is not lost', async () => {
    seedSession([]);
    const appended: Message = { id: 'bang', role: 'assistant', content: 'shell output', timestamp: ISO };
    // Runs inside the turn, before it has written anything back; the null call comes after the write.
    const setAbortController = vi.fn((controller: AbortController | null) => {
      if (!controller) return;
      whenTurnIdle(() => {
        const session = useCliStore.getState().session!;
        useCliStore.getState().setSession({ ...session, messages: [...session.messages, appended] });
      });
    });

    await runTurn('hi', makeCtx({ setAbortController }));

    expect(useCliStore.getState().session!.messages.map(message => message.content)).toContain('shell output');
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

  it('keeps the steps that ran before an abort on the cancellation message', async () => {
    seedSession([]);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const thought: AgentStep = { type: 'thought', content: 'reading the file', metadata: { timestamp: 0 } };
    // Stands in for wireAgentEvents' step handler, which appends each step to
    // the pending assistant message while the run is in flight.
    const run = vi.fn(async () => {
      const { pendingMessages, updatePendingMessage } = useCliStore.getState();
      const last = pendingMessages.length - 1;
      updatePendingMessage(last, { ...pendingMessages[last], metadata: { steps: [thought, observation('ok')] } });
      throw abortError;
    });

    await runTurn('do it', makeCtx({ agent: { run } as unknown as ReActAgent }));

    expect(useCliStore.getState().session!.messages[1]).toMatchObject({
      metadata: { cancelled: true, steps: [thought, observation('ok')] },
    });
  });

  it('flushes durable workflow state onto the session when the turn is aborted (regression: #595)', async () => {
    seedSession([]);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const run = vi.fn(async () => {
      throw abortError;
    });
    const save = vi.fn(async (_session: Session) => undefined);
    // A decision logged before the user hit ESC lives only in the store; the
    // abort save must flush it or it is lost if the process exits mid-turn.
    const decision = { id: 'd1', timestamp: ISO, summary: 'use vitest', rationale: 'repo standard' };
    const ctx = makeCtx({
      agent: { run } as unknown as ReActAgent,
      sessionStore: { save } as unknown as SessionStore,
      workflowStores: {
        decisionStore: { decisions: [decision] },
        blockerStore: { blockers: [] },
        reviewGateStore: { reviewGates: [] },
      },
    });

    await runTurn('do it', ctx);

    // The cancel path performs a single save. Reverting the withFlushedWorkflowState
    // wrap there leaves this saved session's metadata.workflow undefined.
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].metadata.workflow?.decisions).toEqual([decision]);
    // The flush rides alongside the cancellation message, not instead of it.
    expect(useCliStore.getState().session!.messages[1]).toMatchObject({ metadata: { cancelled: true } });
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

  it('counts tool-definition tokens in the proactive auto-compact estimate', async () => {
    const activity = captureTurnActivity();
    // Tiny messages/system prompt alone stay well under 80% of a 500-token
    // window; a tool-heavy agent should push the estimate over regardless.
    seedSession(
      Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'hi',
        timestamp: ISO,
      }))
    );
    const bigTools = Array.from({ length: 20 }, (_, i) => ({
      toolSchema: {
        name: `tool_${i}`,
        description: 'x '.repeat(200),
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    }));
    const run = vi.fn(async (_query: unknown, options?: { maxIterations?: number }) => {
      expect(activity.fireUserPromptSubmit).toHaveBeenCalledOnce();
      expect(activity.fireStop).not.toHaveBeenCalled();
      expect(activity.emitEvent.mock.calls[1][0]).toMatchObject({ type: 'status', status: 'running' });
      return makeResult(options?.maxIterations === 1 ? { finalAnswer: 'a summary' } : {});
    });
    const ctx = makeCtx({
      agent: { run, getTools: () => bigTools } as unknown as ReActAgent,
      config: { preferences: { autoCompact: true } } as unknown as CliConfig,
      availableModels: [{ id: 'claude-sonnet-4-6', contextWindow: 500 } as unknown as ModelInfo],
    });

    await runTurn('next message', ctx);

    // The compaction call (maxIterations: 1) only happens when shouldCompact
    // fired; the main-turn call follows it.
    expect(run).toHaveBeenCalledTimes(2);
    // No live view renders the summary, so it must not trade away transient retries.
    expect(run.mock.calls[0][1]).toMatchObject({ maxIterations: 1, streamText: false });
    expect(activity.fireStop).toHaveBeenCalledOnce();
    expect(activity.emitEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'message', role: 'user', text: 'next message' },
      { type: 'status', status: 'running', text: 'next message' },
      { type: 'status', status: 'awaiting_input' },
    ]);
  });

  it('compacts a Claude session at a window where the same non-Claude session does not', async () => {
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'hi',
      timestamp: ISO,
    }));
    const bigTools: ICompletionOptionTools[] = Array.from({ length: 60 }, (_, i) => ({
      toolFn: async () => '',
      toolSchema: {
        name: `tool_${i}`,
        description: 'x '.repeat(200),
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    }));
    // Tools alone are ~2/3 of the window: unscaled, system prompt + tools + messages
    // stay under 80%, but the x1.5 Claude calibration on the whole estimate pushes
    // the same session over. Reverting forModel in turnController compacts neither.
    const contextWindow = Math.floor(getTokenCounter().countToolSchemaTokens(bigTools) / 0.6);

    const runFor = async (model: string) => {
      seedSession(messages, model);
      const run = vi.fn(async (_query: unknown, options?: { maxIterations?: number }) =>
        makeResult(options?.maxIterations === 1 ? { finalAnswer: 'a summary' } : {})
      );
      const ctx = makeCtx({
        agent: { run, getTools: () => bigTools } as unknown as ReActAgent,
        config: { preferences: { autoCompact: true } } as unknown as CliConfig,
        availableModels: [{ id: model, contextWindow } as unknown as ModelInfo],
      });
      await runTurn('next message', ctx);
      return run;
    };

    const nonClaude = await runFor('plain-model');
    const claude = await runFor('claude-sonnet-5');

    expect(nonClaude).toHaveBeenCalledOnce();
    expect(claude).toHaveBeenCalledTimes(2);
    expect(claude.mock.calls[0][1]).toMatchObject({ maxIterations: 1 });
  });

  it('flushes durable workflow state onto the session before auto-compaction (regression: #595)', async () => {
    // Same trigger as the estimate test above: a tool-heavy agent over a tiny
    // context window forces the 80% auto-compaction branch.
    seedSession(
      Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'hi',
        timestamp: ISO,
      }))
    );
    const bigTools = Array.from({ length: 20 }, (_, i) => ({
      toolSchema: {
        name: `tool_${i}`,
        description: 'x '.repeat(200),
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    }));
    const run = vi.fn(async (_query: unknown, options?: { maxIterations?: number }) =>
      makeResult(options?.maxIterations === 1 ? { finalAnswer: 'a summary' } : {})
    );
    const save = vi.fn(async (_session: Session) => undefined);
    // A decision logged in a prior turn that only lives in the in-memory store;
    // the seeded session's metadata.workflow is still unset when compaction fires.
    const decision = { id: 'd1', timestamp: ISO, summary: 'use vitest', rationale: 'repo standard' };
    const ctx = makeCtx({
      agent: { run, getTools: () => bigTools } as unknown as ReActAgent,
      sessionStore: { save } as unknown as SessionStore,
      config: { preferences: { autoCompact: true } } as unknown as CliConfig,
      availableModels: [{ id: 'claude-sonnet-4-6', contextWindow: 500 } as unknown as ModelInfo],
      workflowStores: {
        decisionStore: { decisions: [decision] },
        blockerStore: { blockers: [] },
        reviewGateStore: { reviewGates: [] },
      },
    });

    await runTurn('next message', ctx);

    // The pre-compaction flush is the first save. It must carry the store's
    // decision so createCompactedSession copies live workflow state forward
    // rather than the stale (empty) metadata snapshot - the exact #595 bug.
    // Reverting withFlushedWorkflowState leaves this save's workflow undefined.
    expect(save.mock.calls[0][0].metadata.workflow?.decisions).toEqual([decision]);
  });

  it('neither records a cancellation nor runs queued input once a sign-in restart replaced the session', async () => {
    seedSession([]);
    let generation = 1;
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const run = vi.fn(async () => {
      if (generation === 1) useCliStore.getState().enqueueMessage('typed meanwhile', 'followUp');
      generation = 2;
      throw abortError;
    });
    const save = vi.fn(async () => undefined);

    await runTurn(
      'do it',
      makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionStore: { save } as unknown as SessionStore,
        sessionGeneration: () => generation,
      })
    );

    expect(run).toHaveBeenCalledOnce();
    expect(useCliStore.getState().session!.messages.some(m => m.metadata?.cancelled)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(useCliStore.getState().messageQueue).toEqual([]);
    expect(useCliStore.getState().inputValue).toBe('typed meanwhile');
  });

  it('writes no reply into the session that a sign-in restart put in place mid-turn', async () => {
    seedSession([]);
    let generation = 1;
    const run = vi.fn(async () => {
      generation = 2;
      useCliStore.getState().setSession({ ...useCliStore.getState().session!, id: 'sess-2', messages: [] });
      return makeResult({ finalAnswer: 'late reply' });
    });
    const save = vi.fn(async () => undefined);

    await runTurn(
      'do it',
      makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionStore: { save } as unknown as SessionStore,
        sessionGeneration: () => generation,
      })
    );

    expect(useCliStore.getState().session).toMatchObject({ id: 'sess-2', messages: [] });
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the new session's pending reply, spinner and abort controller alone when the old turn fails", async () => {
    seedSession([]);
    let generation = 1;
    const theirs: Message = { id: 'theirs', role: 'assistant', content: '', timestamp: ISO };
    const run = vi.fn(async () => {
      generation = 2;
      useCliStore.setState({ pendingMessages: [theirs], isThinking: true });
      throw new Error('boom');
    });
    const setAbortController = vi.fn((_controller: AbortController | null) => {});

    await runTurn(
      'do it',
      makeCtx({ agent: { run } as unknown as ReActAgent, setAbortController, sessionGeneration: () => generation })
    );

    expect(useCliStore.getState().pendingMessages).toEqual([theirs]);
    expect(useCliStore.getState().isThinking).toBe(true);
    expect(setAbortController).not.toHaveBeenCalledWith(null);
  });

  it('drops an auto-compaction that finishes after a sign-in restart replaced the session', async () => {
    seedSession(
      Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'hi',
        timestamp: ISO,
      }))
    );
    const bigTools = Array.from({ length: 20 }, (_, i) => ({
      toolSchema: {
        name: `tool_${i}`,
        description: 'x '.repeat(200),
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    }));
    let generation = 1;
    const replacement = { ...useCliStore.getState().session!, id: 'sess-2', messages: [] };
    const run = vi.fn(async (_query: unknown, options?: { maxIterations?: number }) => {
      if (options?.maxIterations === 1) {
        generation = 2;
        useCliStore.getState().setSession(replacement);
        return makeResult({ finalAnswer: 'a summary' });
      }
      return makeResult();
    });
    const save = vi.fn(async (_session: Session) => undefined);

    await runTurn(
      'next message',
      makeCtx({
        agent: { run, getTools: () => bigTools } as unknown as ReActAgent,
        sessionStore: { save } as unknown as SessionStore,
        config: { preferences: { autoCompact: true } } as unknown as CliConfig,
        availableModels: [{ id: 'claude-sonnet-4-6', contextWindow: 500 } as unknown as ModelInfo],
        sessionGeneration: () => generation,
      })
    );

    expect(run).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(useCliStore.getState().session).toBe(replacement);
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

  describe('workflow reminder wiring', () => {
    const stores = () => ({
      todoStore: { todos: [{ description: 'fix the bug', status: 'in_progress' }] as TodoItem[] },
      decisionStore: {
        decisions: [{ id: 'd1', timestamp: ISO, summary: 'use vitest', rationale: 'repo standard' }],
      },
      blockerStore: {
        blockers: [{ id: 'b1', createdAt: ISO, description: 'waiting on API key', status: 'open' as const }],
      },
    });

    it('passes a workflowReminder provider that renders the live store state', async () => {
      seedSession([]);
      const run = vi.fn(async (_query: unknown, _options?: unknown) => makeResult());
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, ...stores() });

      await runTurn('hello', ctx);

      const options = run.mock.calls[0][1] as { workflowReminder?: () => string | null };
      expect(options.workflowReminder).toBeTypeOf('function');
      const rendered = options.workflowReminder!();
      expect(rendered).toContain('1. [in_progress] fix the bug');
      expect(rendered).toContain('- waiting on API key');
      expect(rendered).toContain('- use vitest (rationale: repo standard)');
    });

    it('re-renders current state on each call (live, not a snapshot)', async () => {
      seedSession([]);
      const run = vi.fn(async (_query: unknown, _options?: unknown) => makeResult());
      const liveStores = stores();
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent, ...liveStores });

      await runTurn('hello', ctx);
      const options = run.mock.calls[0][1] as { workflowReminder?: () => string | null };

      liveStores.blockerStore.blockers[0].status = 'resolved' as never;
      liveStores.todoStore.todos.push({ description: 'update docs', status: 'pending' });

      const rendered = options.workflowReminder!();
      expect(rendered).not.toContain('waiting on API key');
      expect(rendered).toContain('2. [pending] update docs');
    });

    it('omits the provider when the workflowReminders preference is off', async () => {
      seedSession([]);
      const run = vi.fn(async (_query: unknown, _options?: unknown) => makeResult());
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        configStore: {
          get: vi.fn(async () => ({ preferences: { workflowReminders: false } })),
        } as unknown as TurnContext['configStore'],
        ...stores(),
      });

      await runTurn('hello', ctx);

      const options = run.mock.calls[0][1] as { workflowReminder?: () => string | null };
      expect(options.workflowReminder).toBeUndefined();
    });

    it('omits the provider when no workflow stores are wired', async () => {
      seedSession([]);
      const run = vi.fn(async (_query: unknown, _options?: unknown) => makeResult());
      const ctx = makeCtx({ agent: { run } as unknown as ReActAgent });

      await runTurn('hello', ctx);

      const options = run.mock.calls[0][1] as { workflowReminder?: () => string | null };
      expect(options.workflowReminder).toBeUndefined();
    });
  });

  describe('post-edit diagnostics', () => {
    type RunOptions = { drainFeedback?: (phase: 'turn' | 'final') => Promise<string | null> };
    const workspaceRoot = '/workspace/project';

    function diagnosticsCtx(enabled: boolean) {
      const postEditDiagnostics = new PostEditDiagnostics({
        workspaceRoot,
        check: async files => files.map(filePath => ({ filePath, line: 1, column: 1, code: 'TS2322', message: 'bad' })),
      });
      const drained: Array<string | null> = [];
      const run = vi.fn(async (_query: unknown, options?: unknown) => {
        // Stand-in for an edit tool firing mid-turn, then the agent draining before its next request.
        postEditDiagnostics.enqueue('src/a.ts');
        const drain = (options as RunOptions).drainFeedback;
        if (drain) drained.push(await drain('final'));
        return makeResult();
      });
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        configStore: {
          get: vi.fn(async () => ({ preferences: { postEditDiagnostics: enabled } })),
        } as unknown as TurnContext['configStore'],
        postEditDiagnostics,
      });
      return { ctx, run, drained, postEditDiagnostics };
    }

    it('drains edits made during the turn into the agent when the preference is on', async () => {
      seedSession([]);
      const { ctx, drained } = diagnosticsCtx(true);

      await runTurn('hello', ctx);

      expect(drained).toHaveLength(1);
      expect(drained[0]).toContain('src/a.ts:1:1 - TS2322: bad');
    });

    it('stops collecting once the turn ends', async () => {
      seedSession([]);
      const { ctx, postEditDiagnostics } = diagnosticsCtx(true);

      await runTurn('hello', ctx);
      postEditDiagnostics.enqueue('src/b.ts');

      expect(await postEditDiagnostics.drain(1000)).toBeNull();
    });

    it('drains no diagnostics and collects nothing when the preference is off', async () => {
      seedSession([]);
      const { ctx, run, postEditDiagnostics } = diagnosticsCtx(false);

      await runTurn('hello', ctx);

      const drain = (run.mock.calls[0][1] as RunOptions).drainFeedback;
      expect(await drain!('turn')).toBeNull();
      expect(await postEditDiagnostics.drain(1000)).toBeNull();
    });
  });

  describe('steer and follow-up queues', () => {
    type Drain = (phase: 'turn' | 'final') => Promise<string | null>;
    type QueueRunOptions = { signal: AbortSignal; drainFeedback: Drain };

    function abortError(): Error {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return error;
    }

    /** What the user sees in the input and the queue - the two places a queued message can be. */
    const queueState = () => {
      const { messageQueue, inputValue } = useCliStore.getState();
      return { messageQueue, inputValue };
    };
    const sessionMessages = () => useCliStore.getState().session!.messages.map(m => [m.role, m.content]);

    /** ESC as index.tsx wires it: restore the queue to the input, then abort. */
    function pressEsc(signalOwner: QueueRunOptions) {
      useCliStore.getState().restoreQueueToInput();
      (signalOwner as unknown as { controller: AbortController }).controller.abort();
    }

    /** Runs `script` as the agent with the turn's real options; the turn's controller rides along for pressEsc. */
    function queueCtx(script: (options: QueueRunOptions, call: number) => Promise<AgentResult>) {
      let controller: AbortController | null = null;
      let call = 0;
      const run = vi.fn(async (_query: unknown, options?: unknown) => {
        const runOptions = Object.assign(options as QueueRunOptions, { controller });
        return script(runOptions, call++);
      });
      const save = vi.fn(async () => undefined);
      const ctx = makeCtx({
        agent: { run } as unknown as ReActAgent,
        sessionStore: { save } as unknown as SessionStore,
        setAbortController: c => {
          if (c) controller = c;
        },
      });
      return { ctx, run, save };
    }

    it('injects steers queued during a tool batch into the next request, coalesced in submission order', async () => {
      seedSession([]);
      const feedback: Array<string | null> = [];
      const { ctx, run } = queueCtx(async options => {
        useCliStore.getState().enqueueMessage('use pnpm');
        useCliStore.getState().enqueueMessage('and skip the e2e tests');
        feedback.push(await options.drainFeedback('turn'));
        return makeResult();
      });

      await runTurn('run the tests', ctx);

      expect(feedback[0]).toMatch(/while you were working[\s\S]*\n\nuse pnpm\n\nand skip the e2e tests$/);
      expect(sessionMessages()).toEqual([
        ['user', 'run the tests'],
        ['user', 'use pnpm'],
        ['user', 'and skip the e2e tests'],
        ['assistant', 'agent reply'],
      ]);
      expect(useCliStore.getState().session!.messages[1].metadata).toEqual({ steered: true });
      expect(queueState().messageQueue).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
    });

    it('delivers each steer once, at the first boundary after it was sent', async () => {
      seedSession([]);
      const feedback: Array<string | null> = [];
      const { ctx } = queueCtx(async options => {
        useCliStore.getState().enqueueMessage('first steer');
        feedback.push(await options.drainFeedback('turn'));
        feedback.push(await options.drainFeedback('turn'));
        useCliStore.getState().enqueueMessage('second steer');
        feedback.push(await options.drainFeedback('final'));
        return makeResult();
      });

      await runTurn('go', ctx);

      expect(feedback[0]).toMatch(/first steer$/);
      expect(feedback[1]).toBeNull();
      expect(feedback[2]).toMatch(/second steer$/);
      expect(sessionMessages().map(([, content]) => content)).toEqual([
        'go',
        'first steer',
        'second steer',
        'agent reply',
      ]);
    });

    it('leaves follow-ups queued past a steer drain and runs them as the next turn', async () => {
      seedSession([]);
      const feedback: Array<string | null> = [];
      const { ctx, run } = queueCtx(async (options, call) => {
        if (call === 0) {
          useCliStore.getState().enqueueMessage('then write the changelog', 'followUp');
          useCliStore.getState().enqueueMessage('use pnpm');
          feedback.push(await options.drainFeedback('turn'));
        }
        return makeResult();
      });

      await runTurn('run the tests', ctx);

      expect(feedback[0]).toMatch(/use pnpm$/);
      expect(feedback[0]).not.toContain('changelog');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toBe('then write the changelog');
    });

    it('runs a steer that never reached a request boundary as the next turn, in order with follow-ups', async () => {
      seedSession([]);
      const { ctx, run } = queueCtx(async (_options, call) => {
        if (call === 0) {
          useCliStore.getState().enqueueMessage('steer too late');
          useCliStore.getState().enqueueMessage('follow up', 'followUp');
        }
        return makeResult();
      });

      await runTurn('first', ctx);

      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toBe('steer too late\n\nfollow up');
      expect(queueState().messageQueue).toEqual([]);
    });

    it('cancel mid-stream: queued input returns to the input, undelivered and not re-run', async () => {
      seedSession([]);
      useCliStore.getState().setInputValue('half-typed');
      const { ctx, run, save } = queueCtx(async options => {
        useCliStore.getState().enqueueMessage('use pnpm');
        useCliStore.getState().enqueueMessage('later', 'followUp');
        pressEsc(options);
        throw abortError();
      });

      await runTurn('run the tests', ctx);

      expect(queueState()).toEqual({ messageQueue: [], inputValue: 'use pnpm\nlater\nhalf-typed' });
      expect(sessionMessages()).toEqual([
        ['user', 'run the tests'],
        ['assistant', expect.stringContaining('cancelled')],
      ]);
      expect(save).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    });

    it('cancel mid-tool: a drain after the abort delivers nothing, so the steer is not lost to the dead turn', async () => {
      seedSession([]);
      const feedback: Array<string | null> = [];
      const { ctx, run } = queueCtx(async (options, call) => {
        if (call === 0) {
          useCliStore.getState().enqueueMessage('use pnpm');
          // An abort that does not restore the queue (e.g. a denied permission prompt).
          (options as unknown as { controller: AbortController }).controller.abort();
          feedback.push(await options.drainFeedback('turn'));
          return makeResult({ finalAnswer: 'Interrupted' });
        }
        return makeResult();
      });

      await runTurn('run the tests', ctx);

      expect(feedback).toEqual([null]);
      expect(sessionMessages()[1]).toEqual(['assistant', 'Interrupted']);
      // Still queued when the turn settled, so it runs next rather than vanishing.
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toBe('use pnpm');
    });

    it('cancel racing completion: the finished turn is recorded once and post-cancel input runs once', async () => {
      seedSession([]);
      const { ctx, run, save } = queueCtx(async (options, call) => {
        if (call === 0) {
          useCliStore.getState().enqueueMessage('queued before esc');
          // ESC lands after the agent finished but before the turn settled.
          pressEsc(options);
          pressEsc(options);
          useCliStore.getState().enqueueMessage('sent after esc');
        }
        return makeResult({ finalAnswer: `reply ${call}` });
      });

      await runTurn('first', ctx);

      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toBe('sent after esc');
      expect(queueState()).toEqual({ messageQueue: [], inputValue: 'queued before esc' });
      expect(sessionMessages()).toEqual([
        ['user', 'first'],
        ['assistant', 'reply 0'],
        ['user', 'sent after esc'],
        ['assistant', 'reply 1'],
      ]);
      expect(save).toHaveBeenCalledTimes(2);
    });

    it('keeps running queued follow-ups after a turn throws outside its error handling', async () => {
      seedSession([]);
      const { ctx, run } = queueCtx(async () => makeResult());
      const publish = ctx.setAbortController;
      let publishCalls = 0;
      ctx.setAbortController = controller => {
        if (publishCalls++ === 0) {
          useCliStore.getState().enqueueMessage('next', 'followUp');
          throw new Error('ui update failed');
        }
        publish(controller);
      };

      await runTurn('first', ctx);

      expect(run.mock.calls.map(c => c[0])).toEqual(['next']);
      expect(useCliStore.getState().turnInFlight).toBe(false);
    });

    it('queues a turn started while one is in flight instead of running two agent loops at once', async () => {
      seedSession([]);
      let active = 0;
      let maxActive = 0;
      const { ctx, run } = queueCtx(async (_options, call) => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (call === 0) await runTurn('from the tavern', ctx);
        await Promise.resolve();
        active--;
        return makeResult();
      });

      await runTurn('first', ctx);

      expect(maxActive).toBe(1);
      expect(run.mock.calls.map(c => c[0])).toEqual(['first', 'from the tavern']);
      expect(useCliStore.getState().turnInFlight).toBe(false);
    });
  });
});
