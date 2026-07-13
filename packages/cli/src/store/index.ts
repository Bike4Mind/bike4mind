import { create } from 'zustand';
import type { Session, Message } from '../storage';
import type { PermissionResponse } from '../components';
import type { BackgroundAgentJob, BackgroundAgentStatus } from '../agents/types.js';
import type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';
import type { ShellSession, ShellSessionStatus } from '@bike4mind/services/llm/tools/cliTools';
import type { HeartbeatLogEntry } from '../features/tavern/types.js';
import type { ReviewGateResponse } from '../tools/reviewGateTool.js';

/** Active job statuses (jobs still in progress) */
const ACTIVE_STATUSES: ReadonlySet<BackgroundAgentStatus> = new Set(['running', 'queued']);

/**
 * Interaction modes cycled via Shift+Tab.
 * - normal: every dangerous tool prompts
 * - auto-accept: skips the permission prompt for dangerous tools
 * - plan: blocks non-readonly tools so the model researches and proposes a plan instead of executing
 */
export type InteractionMode = 'normal' | 'auto-accept' | 'plan';

const INTERACTION_MODE_CYCLE: ReadonlyArray<InteractionMode> = ['normal', 'auto-accept', 'plan'];

function nextInteractionMode(current: InteractionMode): InteractionMode {
  const idx = INTERACTION_MODE_CYCLE.indexOf(current);
  return INTERACTION_MODE_CYCLE[(idx + 1) % INTERACTION_MODE_CYCLE.length];
}

/** Check if a job status is active (running or queued) */
function isActiveStatus(status: BackgroundAgentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** A shell session is active only while running; all other states are terminal. */
function isActiveShellStatus(status: ShellSessionStatus): boolean {
  return status === 'running';
}

interface PermissionPromptState {
  /** Unique ID for this prompt (used as React key for remount) */
  id: string;
  toolName: string;
  args: unknown;
  preview?: string;
  canBeTrusted: boolean;
  resolve: (response: { action: PermissionResponse }) => void;
}

export interface UserQuestionPromptState {
  /** Unique ID for this prompt (used as React key for remount) */
  id: string;
  payload: UserQuestionPayload;
  resolve: (response: UserQuestionResponse) => void;
}

export interface ReviewGatePromptState {
  /** Unique ID for this prompt (used as React key for remount) */
  id: string;
  description: string;
  options?: string[];
  recommendation?: string;
  resolve: (response: ReviewGateResponse) => void;
}

export interface ExitHandoffPromptState {
  /** Unique ID for this prompt (used as React key for remount) */
  id: string;
  resolve: (generate: boolean) => void;
}

interface CliStore {
  // Session state
  session: Session | null;
  setSession: (session: Session | null) => void;
  addMessage: (message: Session['messages'][0]) => void;
  /**
   * Roll a completed subagent run's usage into session metadata. Uses the
   * functional set() form (reads latest state at call time) so a background
   * job completing mid-turn can't be lost to a stale-closure overwrite.
   */
  recordSubagentUsage: (usage: { tokens: number; credits?: number }) => void;

  // Pending messages (ongoing, not yet complete)
  pendingMessages: Message[];
  addPendingMessage: (message: Message) => void;
  updatePendingMessage: (index: number, message: Message) => void;
  clearPendingMessages: () => void;
  completePendingMessage: (index: number, finalMessage: Message) => void;

  // User-message queue: when the user submits while the agent is already
  // processing, the new message is enqueued here and drained by the
  // handleMessage finally block. All queued messages are collated into a
  // single combined prompt on drain (see dequeueAllMessages). Mirrors the
  // permissionQueue shape.
  messageQueue: string[];
  enqueueMessage: (message: string) => void;
  dequeueAllMessages: () => string[];
  clearMessageQueue: () => void;

  // UI state
  isThinking: boolean;
  setIsThinking: (thinking: boolean) => void;

  // Input state (for Ctrl+C clearing)
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  // Paste state
  pastedContent: string | null;
  pastedLineCount: number;
  setPastedContent: (content: string, lineCount: number) => void;
  clearPaste: () => void;

  // Permission prompt queue (supports concurrent agents)
  permissionPrompt: PermissionPromptState | null;
  permissionQueue: PermissionPromptState[];
  enqueuePermissionPrompt: (prompt: PermissionPromptState) => void;
  dequeuePermissionPrompt: () => void;
  /**
   * Resolve a queued or active permission prompt by id without going through
   * the Ink UI. Used by the tavern bridge presence so an Allow/Deny click in
   * the tavern modal can answer the prompt remotely. Returns true if a prompt
   * with that id was found and resolved; false otherwise (e.g. the local Ink
   * UI already answered it). Safe to race against the Ink UI: whoever wins
   * removes the prompt from the store, the loser no-ops.
   */
  resolvePermissionPromptById: (id: string, response: PermissionResponse) => boolean;
  // User question prompt queue (mirrors permission prompt pattern)
  userQuestionPrompt: UserQuestionPromptState | null;
  userQuestionQueue: UserQuestionPromptState[];
  enqueueUserQuestionPrompt: (prompt: UserQuestionPromptState) => void;
  dequeueUserQuestionPrompt: () => void;

  // Review gate prompt queue (mirrors permission prompt pattern)
  reviewGatePrompt: ReviewGatePromptState | null;
  reviewGateQueue: ReviewGatePromptState[];
  enqueueReviewGatePrompt: (prompt: ReviewGatePromptState) => void;
  dequeueReviewGatePrompt: () => void;

  // Exit-time handoff prompt - single-shot y/n confirmation shown when exiting
  // an eligible session that has no handoff yet. Not queued: an exit flow can
  // only have one in flight at a time.
  exitHandoffPrompt: ExitHandoffPromptState | null;
  setExitHandoffPrompt: (prompt: ExitHandoffPromptState | null) => void;

  // Config editor
  showConfigEditor: boolean;
  setShowConfigEditor: (show: boolean) => void;

  // MCP viewer
  showMcpViewer: boolean;
  setShowMcpViewer: (show: boolean) => void;

  // Interaction mode (Shift+Tab cycles: normal -> auto-accept -> plan -> normal)
  interactionMode: InteractionMode;
  cycleInteractionMode: () => void;
  setInteractionMode: (mode: InteractionMode) => void;

  // Exit handling
  exitRequested: boolean;
  setExitRequested: (requested: boolean) => void;

  // Background agents
  backgroundAgents: BackgroundAgentJob[];
  upsertBackgroundAgent: (job: BackgroundAgentJob) => void;
  cleanupCompletedBackgroundAgents: () => void;

  // Background shell sessions (bash_execute run_in_background / yield_time_ms)
  backgroundShells: ShellSession[];
  upsertBackgroundShell: (session: ShellSession) => void;
  cleanupCompletedBackgroundShells: () => void;

  // Completed group notifications (shown to user when all agents in a group finish)
  completedGroupNotifications: Array<{ notification: string; groupDescription?: string; timestamp: number }>;
  addCompletedGroupNotification: (notification: string, groupDescription?: string) => void;
  clearCompletedGroupNotifications: () => void;

  // Trigger for auto-processing background results when agent is idle
  pendingBackgroundTrigger: boolean;
  setPendingBackgroundTrigger: (pending: boolean) => void;

  // Tavern activity log (capped ring buffer)
  tavernActivityLog: HeartbeatLogEntry[];
  addTavernLogEntry: (entry: HeartbeatLogEntry) => void;
  clearTavernActivityLog: () => void;
}

export const useCliStore = create<CliStore>(set => ({
  // Session state
  session: null,
  setSession: session => set({ session }),
  addMessage: message =>
    set(state => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          updatedAt: new Date().toISOString(),
        },
      };
    }),
  recordSubagentUsage: ({ tokens, credits }) =>
    set(state => {
      if (!state.session) return state;
      const metadata = state.session.metadata;
      return {
        session: {
          ...state.session,
          metadata: {
            ...metadata,
            subagentCalls: (metadata.subagentCalls || 0) + 1,
            subagentTokens: (metadata.subagentTokens || 0) + tokens,
            subagentCost: (metadata.subagentCost || 0) + (credits || 0),
          },
        },
      };
    }),

  // Pending messages
  pendingMessages: [],
  addPendingMessage: message => set(state => ({ pendingMessages: [...state.pendingMessages, message] })),
  updatePendingMessage: (index, message) =>
    set(state => {
      const updated = [...state.pendingMessages];
      updated[index] = message;
      return { pendingMessages: updated };
    }),
  clearPendingMessages: () => set({ pendingMessages: [] }),
  completePendingMessage: (index, finalMessage) =>
    set(state => {
      const pending = [...state.pendingMessages];
      pending.splice(index, 1);
      const session = state.session;
      if (!session) return { pendingMessages: pending };
      return {
        pendingMessages: pending,
        session: {
          ...session,
          messages: [...session.messages, finalMessage],
          updatedAt: new Date().toISOString(),
        },
      };
    }),

  // User-message queue
  messageQueue: [],
  enqueueMessage: message => set(state => ({ messageQueue: [...state.messageQueue, message] })),
  dequeueAllMessages: () => {
    let all: string[] = [];
    set(state => {
      if (state.messageQueue.length === 0) return state;
      all = state.messageQueue;
      return { messageQueue: [] };
    });
    return all;
  },
  clearMessageQueue: () => set({ messageQueue: [] }),

  // UI state
  isThinking: false,
  setIsThinking: thinking => set({ isThinking: thinking }),

  // Input state (for Ctrl+C clearing)
  inputValue: '',
  setInputValue: value => set({ inputValue: value }),
  clearInput: () => set({ inputValue: '', pastedContent: null, pastedLineCount: 0 }),

  // Paste state
  pastedContent: null,
  pastedLineCount: 0,
  setPastedContent: (content, lineCount) =>
    set({
      pastedContent: content,
      pastedLineCount: lineCount,
      inputValue: content,
    }),
  clearPaste: () => set({ pastedContent: null, pastedLineCount: 0, inputValue: '' }),

  // Permission prompt queue
  permissionPrompt: null,
  permissionQueue: [],
  enqueuePermissionPrompt: prompt =>
    set(state => {
      if (!state.permissionPrompt) {
        // No active prompt - show immediately
        return { permissionPrompt: prompt };
      }
      // Active prompt exists - queue this one
      return { permissionQueue: [...state.permissionQueue, prompt] };
    }),
  dequeuePermissionPrompt: () =>
    set(state => {
      const [next, ...rest] = state.permissionQueue;
      return {
        permissionPrompt: next ?? null,
        permissionQueue: rest,
      };
    }),
  resolvePermissionPromptById: (id, response) => {
    const state = useCliStore.getState();
    if (state.permissionPrompt?.id === id) {
      const target = state.permissionPrompt;
      // setState first so any sync consumer reads the post-removal store before
      // the resolved promise drives downstream effects.
      state.dequeuePermissionPrompt();
      target.resolve({ action: response });
      return true;
    }
    const queueIdx = state.permissionQueue.findIndex(p => p.id === id);
    if (queueIdx >= 0) {
      const target = state.permissionQueue[queueIdx];
      const nextQueue = [...state.permissionQueue.slice(0, queueIdx), ...state.permissionQueue.slice(queueIdx + 1)];
      useCliStore.setState({ permissionQueue: nextQueue });
      target.resolve({ action: response });
      return true;
    }
    return false;
  },

  // User question prompt queue
  userQuestionPrompt: null,
  userQuestionQueue: [],
  enqueueUserQuestionPrompt: prompt =>
    set(state => {
      if (!state.userQuestionPrompt) {
        return { userQuestionPrompt: prompt };
      }
      return { userQuestionQueue: [...state.userQuestionQueue, prompt] };
    }),
  dequeueUserQuestionPrompt: () =>
    set(state => {
      const [next, ...rest] = state.userQuestionQueue;
      return {
        userQuestionPrompt: next ?? null,
        userQuestionQueue: rest,
      };
    }),

  // Review gate prompt queue
  reviewGatePrompt: null,
  reviewGateQueue: [],
  enqueueReviewGatePrompt: prompt =>
    set(state => {
      if (!state.reviewGatePrompt) {
        return { reviewGatePrompt: prompt };
      }
      return { reviewGateQueue: [...state.reviewGateQueue, prompt] };
    }),
  dequeueReviewGatePrompt: () =>
    set(state => {
      const [next, ...rest] = state.reviewGateQueue;
      return {
        reviewGatePrompt: next ?? null,
        reviewGateQueue: rest,
      };
    }),

  // Exit-time handoff prompt
  exitHandoffPrompt: null,
  setExitHandoffPrompt: prompt => set({ exitHandoffPrompt: prompt }),

  // Config editor
  showConfigEditor: false,
  setShowConfigEditor: show => set({ showConfigEditor: show }),

  // MCP viewer
  showMcpViewer: false,
  setShowMcpViewer: show => set({ showMcpViewer: show }),

  // Interaction mode (Shift+Tab cycles)
  interactionMode: 'normal',
  cycleInteractionMode: () => set(state => ({ interactionMode: nextInteractionMode(state.interactionMode) })),
  setInteractionMode: mode => set({ interactionMode: mode }),

  // Exit handling
  exitRequested: false,
  setExitRequested: requested => set({ exitRequested: requested }),

  // Background agents
  backgroundAgents: [],
  upsertBackgroundAgent: job =>
    set(state => {
      const existing = state.backgroundAgents.findIndex(j => j.id === job.id);
      if (existing >= 0) {
        const updated = [...state.backgroundAgents];
        updated[existing] = job;
        return { backgroundAgents: updated };
      }
      return { backgroundAgents: [...state.backgroundAgents, job] };
    }),
  cleanupCompletedBackgroundAgents: () =>
    set(state => ({
      backgroundAgents: state.backgroundAgents.filter(j => isActiveStatus(j.status)),
    })),

  // Background shell sessions
  backgroundShells: [],
  upsertBackgroundShell: session =>
    set(state => {
      const existing = state.backgroundShells.findIndex(s => s.id === session.id);
      if (existing >= 0) {
        const updated = [...state.backgroundShells];
        updated[existing] = session;
        return { backgroundShells: updated };
      }
      return { backgroundShells: [...state.backgroundShells, session] };
    }),
  cleanupCompletedBackgroundShells: () =>
    set(state => ({
      backgroundShells: state.backgroundShells.filter(s => isActiveShellStatus(s.status)),
    })),

  // Completed group notifications
  completedGroupNotifications: [],
  addCompletedGroupNotification: (notification, groupDescription) =>
    set(state => ({
      completedGroupNotifications: [
        ...state.completedGroupNotifications,
        { notification, groupDescription, timestamp: Date.now() },
      ],
    })),
  clearCompletedGroupNotifications: () => set({ completedGroupNotifications: [] }),

  // Pending background trigger
  pendingBackgroundTrigger: false,
  setPendingBackgroundTrigger: pending => set({ pendingBackgroundTrigger: pending }),

  // Tavern activity log (capped at 200 entries)
  tavernActivityLog: [],
  addTavernLogEntry: entry =>
    set(state => {
      const log = [...state.tavernActivityLog, entry];
      return { tavernActivityLog: log.length > 200 ? log.slice(-200) : log };
    }),
  clearTavernActivityLog: () => set({ tavernActivityLog: [] }),
}));

// Pre-built selectors for common patterns
const EMPTY_JOBS = [] as BackgroundAgentJob[];

/** Select only active (running or queued) background agents */
export const selectActiveBackgroundAgents = (state: CliStore): BackgroundAgentJob[] =>
  state.backgroundAgents.filter(j => isActiveStatus(j.status));

/** Select only completed background agents */
export const selectCompletedBackgroundAgents = (state: CliStore): BackgroundAgentJob[] => {
  const completed = state.backgroundAgents.filter(j => !isActiveStatus(j.status));
  return completed.length === 0 ? EMPTY_JOBS : completed;
};

const EMPTY_SHELLS = [] as ShellSession[];

/** Select only running background shell sessions */
export const selectActiveBackgroundShells = (state: CliStore): ShellSession[] => {
  const active = state.backgroundShells.filter(s => isActiveShellStatus(s.status));
  return active.length === 0 ? EMPTY_SHELLS : active;
};

/** Select only terminal (exited/killed/timed_out) background shell sessions */
export const selectCompletedBackgroundShells = (state: CliStore): ShellSession[] => {
  const completed = state.backgroundShells.filter(s => !isActiveShellStatus(s.status));
  return completed.length === 0 ? EMPTY_SHELLS : completed;
};
