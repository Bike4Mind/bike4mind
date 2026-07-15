/**
 * Session lifecycle (issue #228, phase 3).
 *
 * These functions own the create / resume / compact / rewind transitions of the
 * active conversation. Like `runTurn` (phase 2) they are transport-agnostic and
 * React-free: every collaborator arrives through `SessionLifecycleContext`, and
 * the active session is read from / written to the Zustand store (the single
 * source of truth from #227) rather than React state. `index.tsx` keeps only
 * thin wrappers that supply the context and the genuinely UI-bound pieces -
 * `console.clear()` / `renderBanner()`, the interactive session/rewind selectors,
 * and the rewind input prefill.
 */
import { v4 as uuidv4 } from 'uuid';
import { ChatModels } from '@bike4mind/common';
import { ReActAgent } from '@bike4mind/agents';
import type { SessionStore, Session, Message } from '../storage';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import type { DecisionStore, BlockerStore, ReviewGateStore } from '../tools';
import { useCliStore } from '../store';
import { logger } from '../utils/Logger';
import { buildCompactionPrompt, createCompactedSession } from '../utils/compaction.js';
import { extractCompactInstructions } from '../utils';
import { injectHandoffMessage, formatHandoffOutput } from '../utils/handoff.js';

/**
 * Collaborators the lifecycle transitions need. React-free by design: stores and
 * services are injectable, the workflow stores are the same singletons the tools
 * mutate, and the two callbacks let `index.tsx` run its remaining side effects
 * (memoised-usage invalidation, review-gate queue drain) without this module
 * knowing about React. The active session is deliberately absent - it lives
 * solely in `useCliStore`.
 */
export interface SessionLifecycleContext {
  agent: ReActAgent | null;
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore | null;
  /** Fallback model when there is no current session to inherit from. */
  defaultModel: string | undefined;
  /** Raw CLAUDE.md content, mined for user compaction instructions. */
  contextContent: string;
  decisionStore: DecisionStore;
  blockerStore: BlockerStore;
  reviewGateStore: ReviewGateStore;
  /** Invalidate memoised /usage data so the next read reflects the new session. */
  onSessionReplaced: () => void;
  /** Drain any in-flight review-gate prompt from the UI queue (create only). */
  drainReviewGatePrompt: () => void;
}

/**
 * Recompute the token / cost / tool-call totals from the messages themselves.
 * Used by rewind, where dropping messages must shrink the metadata to match.
 */
export function recalculateSessionMetadata(messages: Message[]): {
  totalTokens: number;
  totalCost: number;
  toolCallCount: number;
} {
  let totalTokens = 0;
  let totalCost = 0;
  let toolCallCount = 0;

  for (const msg of messages) {
    if (msg.metadata) {
      if (msg.metadata.tokenUsage) {
        totalTokens += msg.metadata.tokenUsage.total || 0;
      }

      if (msg.metadata.cost) {
        totalCost += msg.metadata.cost;
      }

      // Count tool calls from steps (observations = completed tools)
      if (msg.metadata.steps) {
        const observations = msg.metadata.steps.filter(s => s.type === 'observation');
        toolCallCount += observations.length;
      }
    }
  }

  return {
    totalTokens,
    totalCost,
    toolCallCount,
  };
}

/**
 * Create a fresh empty session and install it as the active one (the /new and
 * /clear core). Inherits the model from the current session, else the configured
 * default, else Sonnet. In pinned-session mode (host board pane, B4M_SESSION_ID /
 * B4M_RESUME_ID) the id is preserved so the host's --resume still finds this
 * conversation after a clear. Resets workflow state and the checkpoint session so
 * old decisions/blockers/checkpoints don't leak forward. Returns the new session
 * for the caller to log; screen-clear and banner re-render stay in the wrapper.
 */
export async function createFreshSession(ctx: SessionLifecycleContext): Promise<Session> {
  const currentSession = useCliStore.getState().session;
  const model = currentSession?.model || ctx.defaultModel || ChatModels.CLAUDE_4_5_SONNET;
  const clearPinnedId = process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID;
  const newSession: Session = {
    id: clearPinnedId ? (currentSession?.id ?? clearPinnedId) : uuidv4(),
    name: `Session ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model,
    messages: [],
    metadata: {
      totalTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  };

  await logger.initialize(newSession.id);
  logger.debug('=== New Session Started via /clear ===');

  // Reset workflow stores so old decisions/blockers don't leak into new session
  ctx.decisionStore.decisions = [];
  ctx.blockerStore.blockers = [];

  ctx.checkpointStore?.setSessionId(newSession.id);

  useCliStore.getState().setSession(newSession);
  useCliStore.getState().clearPendingMessages();

  // Drain any stale review gate prompt from the UI queue. The agent shouldn't be
  // running during /clear, but guard against an in-flight gate Promise leaking by
  // resolving it as a rejection so the agent unwinds cleanly if it ever does.
  const staleGate = useCliStore.getState().reviewGatePrompt;
  if (staleGate) {
    ctx.drainReviewGatePrompt();
    staleGate.resolve({ decision: 'rejected', note: 'Session cleared.' });
  }

  // Reset reviewGates *after* the drained gate's toolFn continuation runs. The
  // continuation is scheduled as a microtask by the resolve() above, and it
  // pushes a rejection entry into the store. Clearing synchronously here would
  // let that push leak into the new session; deferring to the next microtask
  // ensures we replace the array after the push, dropping the ghost entry.
  queueMicrotask(() => {
    ctx.reviewGateStore.reviewGates = [];
  });

  ctx.onSessionReplaced();

  return newSession;
}

/**
 * Load a previously-saved session and install it as the active one (the /resume
 * selector core). Injects any structured handoff as a system message so the AI
 * picks up continuity context, not just raw chat history. Prints the resume
 * summary and handoff. Returns the session as installed (with handoff injected),
 * or null if the file could not be loaded.
 */
export async function resumeSession(ctx: SessionLifecycleContext, selected: Session): Promise<Session | null> {
  const loadedSession = await ctx.sessionStore.load(selected.id);

  if (!loadedSession) {
    console.log(`❌ Failed to load session: ${selected.name}`);
    console.log('   The session file may be corrupted or deleted.');
    return null;
  }

  await logger.initialize(loadedSession.id);
  logger.debug('=== Session Resumed ===');

  ctx.checkpointStore?.setSessionId(loadedSession.id);

  // injectHandoffMessage replaces any prior injected handoff to avoid stacking
  // on repeated save/resume cycles.
  const handoff = loadedSession.metadata.workflow?.handoff;
  const sessionForState: Session = handoff
    ? { ...loadedSession, messages: injectHandoffMessage(loadedSession.messages, handoff) }
    : loadedSession;

  useCliStore.getState().setSession(sessionForState);
  useCliStore.getState().clearPendingMessages();
  ctx.onSessionReplaced();

  console.log(`\n✅ Session resumed: "${sessionForState.name}"`);
  console.log(
    `📝 ${sessionForState.messages.length} messages | 🤖 ${sessionForState.model} | 📊 ${sessionForState.metadata.totalTokens.toLocaleString()} tokens\n`
  );

  if (handoff) {
    console.log('🤝 Session handoff:\n');
    console.log(formatHandoffOutput(handoff));
  }

  return sessionForState;
}

/**
 * Summarise the conversation into a fresh compacted session (the /compact core).
 * Runs the agent for a single no-tool iteration to produce the summary, preserves
 * the old session to disk first, then installs the compacted one. No-ops (with a
 * console notice) when there is no session/agent or too little to compact.
 */
export async function compactSession(
  ctx: SessionLifecycleContext,
  options: { userInstructions?: string } = {}
): Promise<void> {
  const session = useCliStore.getState().session;
  if (!session || !ctx.agent) {
    console.log('No active session');
    return;
  }

  if (session.messages.length < 6) {
    console.log('Not enough messages to compact (need at least 6)');
    return;
  }

  const { prompt: compactionPrompt, preservedMessages } = buildCompactionPrompt(session.messages, {
    userInstructions: options.userInstructions,
    claudeMdInstructions: extractCompactInstructions(ctx.contextContent),
  });

  if (!compactionPrompt) {
    console.log('Not enough messages to compact');
    return;
  }

  console.log('\u{1F5DC}\uFE0F  Compacting conversation...\n');

  useCliStore.getState().setIsThinking(true);

  try {
    // Single iteration, no tools - just summarise.
    const result = await ctx.agent.run(compactionPrompt, { maxIterations: 1 });
    const summary = result.finalAnswer;

    // Save old session first so it is preserved before we swap in the new one.
    await ctx.sessionStore.save(session);
    const oldSessionName = session.name;

    const newSession = createCompactedSession(
      session,
      summary,
      preservedMessages,
      !!(process.env.B4M_SESSION_ID || process.env.B4M_RESUME_ID)
    );

    await logger.initialize(newSession.id);

    useCliStore.getState().setSession(newSession);
    useCliStore.getState().clearPendingMessages();

    console.log('✅ Conversation compacted');
    console.log(`\u{1F4DD} New session: ${newSession.name}`);
    console.log(`\u{1F4BE} Previous session preserved: ${oldSessionName}\n`);
  } finally {
    useCliStore.getState().setIsThinking(false);
  }
}

/**
 * Truncate the conversation to before the selected message and persist it (the
 * /rewind selector-resolve core). The dropped message's content is returned as
 * `prefill` so the caller can seed the input for the user to edit and re-send.
 * Returns null if there is no active session. Metadata is recalculated from the
 * remaining messages; subagent totals are carried forward since they are not
 * derivable from message data.
 */
export async function rewindSession(
  ctx: SessionLifecycleContext,
  messageIndex: number
): Promise<{ prefill: string } | null> {
  const activeSession = useCliStore.getState().session;
  if (!activeSession) {
    console.log('❌ No active session');
    return null;
  }

  const selectedMessage = activeSession.messages[messageIndex];
  const prefillContent = selectedMessage?.content || '';

  // Remove the selected message and everything after it; the user re-sends
  // (possibly edited) from the input.
  const rewindedMessages = activeSession.messages.slice(0, messageIndex);
  const newMetadata = recalculateSessionMetadata(rewindedMessages);

  const rewindedSession: Session = {
    ...activeSession,
    messages: rewindedMessages,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...newMetadata,
      // Not derivable from message data - carry forward rather than zeroing
      subagentCalls: activeSession.metadata.subagentCalls,
      subagentTokens: activeSession.metadata.subagentTokens,
      subagentCost: activeSession.metadata.subagentCost,
      subagentUsage: activeSession.metadata.subagentUsage,
    },
  };

  useCliStore.getState().setSession(rewindedSession);
  useCliStore.getState().clearPendingMessages();

  try {
    await ctx.sessionStore.save(rewindedSession);
  } catch (error) {
    // The in-memory rewind has already applied, so a persist failure must still
    // return the prefill: otherwise the caller never seeds the input and the
    // user silently loses the message they were about to edit and re-send.
    console.error(
      `\n❌ Rewound, but failed to save the session: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return { prefill: prefillContent };
  }

  console.log('✅ Conversation rewound successfully');
  console.log(`📊 Current state: ${rewindedMessages.length} messages, ${newMetadata.totalTokens} tokens`);
  console.log(`📝 Your message has been placed in the input. Edit and send when ready.\n`);

  return { prefill: prefillContent };
}
