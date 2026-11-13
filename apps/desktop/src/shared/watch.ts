import { z } from 'zod';
import { activityLabel, type AgentActivity } from './agentActivity';
import { deriveTaskAgentState, type AgentState } from './agentState';
import type { ChatSessionStatus, ChatSessionSummary, ChatToolCall } from './chat';
import { REQUEST_DIRECTORY_TOOL_NAME } from './directoryRequest';
import { isMcpConfigToolName } from './mcp';
import { alertableSessions, rootSessionOf } from './needsYou';
import { ASK_USER_TOOL_NAME } from './questions';
import { descendantsOf } from './spawnTree';
import { describeToolInput } from './toolDetail';

/*
 * The watch model: one summary of every running orchestration, built in main (main/watch) and
 * read by both the menu-bar item and the mini Tavern window, so the two never disagree. Which
 * sessions count, and the needs-you count, come from shared/needsYou.ts, the same rules the dock
 * badge and the notifications use.
 */

/** The menu-bar icon's four states, most prominent first: needs-you > working > done > idle. */
export type WatchOverall = 'idle' | 'working' | 'needs-you' | 'done';

export interface WatchAgent {
  id: string;
  title: string;
  state: AgentState;
  /** What it is doing now, as the roster's "Now" column words it; null when nothing is streaming. */
  activity: string | null;
}

export interface WatchOrchestration {
  rootId: string;
  title: string;
  agents: WatchAgent[];
  /** The root and its agents, so the mini Tavern can build the same roster the stage does. */
  sessions: ChatSessionSummary[];
  statuses: Record<string, ChatSessionStatus>;
  activity: Record<string, AgentActivity>;
  /** Latest `updatedAt` across its sessions, in ms. */
  lastActiveAt: number;
  /** When its oldest still-waiting session started waiting, in ms; null when nobody waits. */
  needsYouSince: number | null;
  /** Its work finished since the user last looked: the menu-bar check and the mini room's cheer. */
  celebrate: boolean;
}

export interface WatchPending {
  approvalId: string;
  sessionId: string;
  rootId: string;
  agentTitle: string;
  orchestrationTitle: string;
  /** Tool name and target, e.g. "bash pnpm test". */
  summary: string;
  /** May be answered from outside the app: see {@link isQuickApproval}. */
  quick: boolean;
  /** When its session started waiting, in ms. */
  since: number;
}

export interface WatchSnapshot {
  overall: WatchOverall;
  needsYouCount: number;
  orchestrations: WatchOrchestration[];
  /** Oldest first. */
  pending: WatchPending[];
}

export const EMPTY_WATCH_SNAPSHOT: WatchSnapshot = {
  overall: 'idle',
  needsYouCount: 0,
  orchestrations: [],
  pending: [],
};

export interface WatchSnapshotInput {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  activity: ReadonlyMap<string, AgentActivity>;
  /** Calls parked at the approval gate, by session; only sessions in needs-action are read. */
  pending: ReadonlyMap<string, readonly ChatToolCall[]>;
  /** When each session entered needs-action, in ms. */
  needsYouSince: ReadonlyMap<string, number>;
  /** Roots whose work finished since the user last looked. */
  unacknowledgedDone: ReadonlySet<string>;
  now: number;
}

// Cards that need input or a closer look than a menu line gives: a question, a folder grant, an
// MCP server's secrets. Matches the special cards ToolCallList draws instead of a plain prompt.
const CARD_TOOLS = new Set([ASK_USER_TOOL_NAME, REQUEST_DIRECTORY_TOOL_NAME]);

/**
 * The longest summary a quick approval may have. The menu bar and the mini card show a quick
 * summary whole (see trayPresentation and NeedsYouCard), so a longer one goes to the app card.
 */
export const QUICK_SUMMARY_MAX = 60;

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * Whether a parked call may be answered "approve once" or "deny" from the menu bar or the mini
 * window. An allow-list: anything with a warning, a reason the gate gave for asking, an irreversible
 * effect, a choice, parts, a diff, a card of its own, or a gate floor that asks in every mode is
 * reviewed in the app, where the full card shows it. The summary is one short line, so a call whose
 * detail is missing or runs past it (a second line, or more than QUICK_SUMMARY_MAX characters) is never quick.
 */
export function isQuickApproval(call: ChatToolCall): boolean {
  if (!call.approvalId || call.status !== 'awaiting-approval') return false;
  if (CARD_TOOLS.has(call.name) || isMcpConfigToolName(call.name)) return false;
  // Only the gate's own detail, never describeToolInput, which collapses and cuts the input.
  const detail = call.approvalDetail?.trim();
  if (!detail || LINE_BREAK.test(detail) || approvalSummary(call).length > QUICK_SUMMARY_MAX) return false;
  return (
    !call.approvalInAppOnly &&
    !call.approvalIrreversible &&
    !call.approvalWarning &&
    !call.approvalReasons?.length &&
    !call.approvalChoice &&
    !call.approvalParts &&
    !call.approvalDiff &&
    !call.approvalDiffs
  );
}

/**
 * The detail's first line. For a quick call that is the whole detail (see isQuickApproval); for any
 * other it only labels a row that leads to the app card, which shows the rest.
 */
export function approvalSummary(call: ChatToolCall): string {
  const detail = (call.approvalDetail ?? describeToolInput(call)).trim().split(LINE_BREAK)[0] ?? '';
  return `${call.name} ${detail}`.trim();
}

const isBusy = (status: ChatSessionStatus | undefined) => status === 'processing' || status === 'needs-action';

function timeOf(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

export function buildWatchSnapshot(input: WatchSnapshotInput): WatchSnapshot {
  const { sessions, statuses, activity, pending, needsYouSince, unacknowledgedDone, now } = input;
  const alertable = alertableSessions(sessions);
  if (alertable.size === 0) return EMPTY_WATCH_SNAPSHOT;

  const byId = new Map(sessions.map(session => [session.id, session]));
  const roots = [...alertable].filter(id => rootSessionOf(sessions, id) === id);

  const orchestrations: WatchOrchestration[] = [];
  const pendingItems: WatchPending[] = [];
  let needsYouCount = 0;
  let working = false;

  for (const rootId of roots) {
    const root = byId.get(rootId);
    if (!root) continue;
    const members = [root, ...descendantsOf(sessions, rootId).map(({ session }) => session as ChatSessionSummary)];
    const agents = members.slice(1).map((session): WatchAgent => {
      const state = deriveTaskAgentState(session, statuses.get(session.id));
      const live = activity.get(session.id);
      return { id: session.id, title: session.title, state, activity: live ? activityLabel(live) : null };
    });

    let since: number | null = null;
    for (const member of members) {
      const status = statuses.get(member.id);
      if (status === 'processing') working = true;
      if (status !== 'needs-action') continue;
      needsYouCount += 1;
      const waitingSince = needsYouSince.get(member.id) ?? now;
      since = since === null ? waitingSince : Math.min(since, waitingSince);
      for (const call of pending.get(member.id) ?? []) {
        if (!call.approvalId || call.status !== 'awaiting-approval') continue;
        pendingItems.push({
          approvalId: call.approvalId,
          sessionId: member.id,
          rootId,
          agentTitle: member.title,
          orchestrationTitle: root.title,
          summary: approvalSummary(call),
          quick: isQuickApproval(call),
          since: waitingSince,
        });
      }
    }

    const finished = members.every(member => !isBusy(statuses.get(member.id)));
    orchestrations.push({
      rootId,
      title: root.title,
      agents,
      sessions: members,
      statuses: Object.fromEntries(
        members.flatMap(member => {
          const status = statuses.get(member.id);
          return status ? [[member.id, status]] : [];
        })
      ),
      activity: Object.fromEntries(
        members.flatMap(member => {
          const live = activity.get(member.id);
          return live ? [[member.id, live]] : [];
        })
      ),
      lastActiveAt: Math.max(...members.map(member => timeOf(member.updatedAt))),
      needsYouSince: since,
      celebrate: finished && unacknowledgedDone.has(rootId),
    });
  }

  pendingItems.sort((a, b) => a.since - b.since);
  const overall: WatchOverall =
    needsYouCount > 0
      ? 'needs-you'
      : working
        ? 'working'
        : orchestrations.some(orchestration => orchestration.celebrate)
          ? 'done'
          : 'idle';
  return { overall, needsYouCount, orchestrations, pending: pendingItems };
}

export interface RoomChoice {
  rootId: string | null;
  /** The room is the user's pick rather than the one attention points at. */
  pinned: boolean;
  /** Pinned, and a different orchestration needs you: the "another room needs you" pill. */
  otherNeedsYou: boolean;
}

/**
 * Which orchestration the mini Tavern shows. Unpinned, it follows attention: the request that has
 * waited longest, else the most recently active orchestration. A pin holds until its room is gone;
 * the mini window drops the pin itself once that room finishes (see useRoomSelection).
 */
export function pickRoom(snapshot: WatchSnapshot, pinned: string | null): RoomChoice {
  const { orchestrations } = snapshot;
  const pinnedRoom =
    pinned === null ? undefined : orchestrations.find(orchestration => orchestration.rootId === pinned);
  if (pinnedRoom) {
    const otherNeedsYou = orchestrations.some(
      orchestration => orchestration.rootId !== pinnedRoom.rootId && orchestration.needsYouSince !== null
    );
    return { rootId: pinnedRoom.rootId, pinned: true, otherNeedsYou };
  }
  const waiting = orchestrations
    .filter(orchestration => orchestration.needsYouSince !== null)
    .sort((a, b) => (a.needsYouSince ?? 0) - (b.needsYouSince ?? 0))[0];
  const recent = [...orchestrations].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  return { rootId: (waiting ?? recent)?.rootId ?? null, pinned: false, otherNeedsYou: false };
}

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type WatchBounds = z.infer<typeof boundsSchema>;

export interface WatchPreferences {
  /** The menu-bar item; on by default, and it only appears once there is an orchestration. */
  showInMenuBar: boolean;
  /** The mini Tavern was open when the app last ran, so it reopens. */
  miniOpen: boolean;
  miniBounds: WatchBounds | null;
}

export const DEFAULT_WATCH_PREFERENCES: WatchPreferences = { showInMenuBar: true, miniOpen: false, miniBounds: null };

/** Field by field, so one bad value (a hand edit, an older file) does not reset the others. */
export function parseWatchPreferences(value: unknown): WatchPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const bounds = boundsSchema.safeParse(record.miniBounds);
  return {
    showInMenuBar:
      typeof record.showInMenuBar === 'boolean' ? record.showInMenuBar : DEFAULT_WATCH_PREFERENCES.showInMenuBar,
    miniOpen: typeof record.miniOpen === 'boolean' ? record.miniOpen : DEFAULT_WATCH_PREFERENCES.miniOpen,
    miniBounds: bounds.success ? bounds.data : null,
  };
}

/** The settings a renderer may change; window bounds and visibility are main's to record. */
export const watchPreferencesPatchSchema = z.object({ showInMenuBar: z.boolean() }).partial().strict();
export type WatchPreferencesPatch = z.infer<typeof watchPreferencesPatchSchema>;

/** A decision the menu bar and the mini window may send: never "always" from outside the app. */
export type WatchDecision = 'once' | 'deny';
export const isWatchDecision = (value: unknown): value is WatchDecision => value === 'once' || value === 'deny';
