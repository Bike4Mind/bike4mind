// Plays a tutorial module into a real session: seeds the recorded quests one turn at a time and remembers
// where the user stands. Every effect is behind `deps`, so the rules are testable without a database.
import {
  BRIDGE_STEP_ID,
  samePrompt,
  TUTORIAL_MARKER_TYPE,
  walkIsCurrent,
  type TutorialRunModule,
} from '@bike4mind/common';
import { questRepository } from '@bike4mind/database';
import type { ITutorialModuleProgress, TutorialModels, TutorialModuleStatus } from './models';
import { progressStoreFor } from './progressStore';
import type { EnsureSheetOptions } from './sheet';
import type { TutorialCanvas, TutorialModule } from './types';

/** How long a claimed turn may sit without its quest before a retry inserts it. */
export const TURN_INSERT_GRACE_MS = 10_000;

export interface TutorialQuest {
  id?: string;
  sessionId: string;
  timestamp: Date;
  type: 'message';
  prompt: string;
  reply: string;
  replies: string[];
  status: 'done';
  fabFileIds?: string[];
  toolResults?: { tool_use_id: string; content: string; is_error?: boolean }[];
  uiSideEffects: { type: string; payload: unknown }[];
  promptMeta: { session: { id: string; userId: string } };
}

/** What answering a turn needs. The chat path has no request in hand, so none of it may read one. */
export interface TutorialTurnDeps {
  modules: readonly TutorialModule[];
  progress: {
    read(userId: string, moduleId: string): Promise<ITutorialModuleProgress | undefined>;
    all(userId: string): Promise<Record<string, ITutorialModuleProgress>>;
    begin(userId: string, moduleId: string, entry: ITutorialModuleProgress): Promise<void>;
    /** Moves turn from `from` to `to` only while the session and turn still match; false when they do not. */
    claimTurn(
      userId: string,
      moduleId: string,
      sessionId: string,
      from: number,
      to: number,
      at: Date
    ): Promise<boolean>;
    /** Re-leases a claimed turn to one retrier: succeeds only while the claim time is still `expected`. */
    reclaimTurn(
      userId: string,
      moduleId: string,
      sessionId: string,
      turn: number,
      expected: Date,
      at: Date
    ): Promise<boolean>;
    setPosition(
      userId: string,
      moduleId: string,
      stepId: string,
      status: TutorialModuleStatus,
      at: Date
    ): Promise<boolean>;
  };
  quests: {
    create(quest: TutorialQuest): Promise<TutorialQuest>;
    findAllBySessionId(sessionId: string): Promise<TutorialQuest[]>;
  };
  /** Absent for an owner whose tutorials record no canvas. */
  canvas?: {
    /** Lands a recorded canvas as the session's ready step for `questId`. A repeat is a no-op. */
    seed(
      row: { sessionId: string; questId: string; userId: string; coversQuestIds: string[] } & Omit<
        TutorialCanvas,
        'turn'
      >
    ): Promise<void>;
  };
  now(): Date;
}

export interface TutorialDeps extends TutorialTurnDeps {
  ensureSheet(userId: string, mod: TutorialModule, options?: EnsureSheetOptions): Promise<string>;
  createSession(mod: TutorialModule): Promise<{ id: string }>;
  ownsSession(sessionId: string, userId: string): Promise<boolean>;
  /** Deletes the user's session; false when it holds work of the user's own and was kept. */
  deleteSession(sessionId: string, userId: string): Promise<boolean>;
  warn(message: string): void;
  /**
   * Marks the session as walking this module, or clears the mark with null. Absent for an owner whose
   * turns are answered by a workspace hook instead of the session marker.
   */
  setSessionMarker?(sessionId: string, userId: string, moduleId: string | null): Promise<void>;
}

/** A recorded reply, written onto the user's own quest in place of a model's. */
export interface TutorialTurnReply {
  replies: string[];
  toolResults?: TutorialQuest['toolResults'];
  uiSideEffects: TutorialQuest['uiSideEffects'];
}

export type TutorialResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; code?: string };

const fail = (status: number, error: string, code?: string) => ({ ok: false as const, status, error, code });

/** The one reply a walk gets after its module changed under it. */
export const TUTORIAL_UPDATED_REPLY = 'This tutorial was updated. Start it again from the Tutorials panel.';
/** The one reply a walk gets after its module was switched off under it; the panel no longer lists it. */
export const TUTORIAL_OFF_REPLY = 'This tutorial was switched off for now. Your conversation carries on.';

async function markSession(deps: TutorialDeps, sessionId: string, userId: string, moduleId: string | null) {
  try {
    await deps.setSessionMarker?.(sessionId, userId, moduleId);
  } catch (error) {
    deps.warn(`tutorial: could not ${moduleId ? 'mark' : 'unmark'} session ${sessionId}: ${String(error)}`);
  }
}

function markerOf(moduleId: string, turn: number) {
  return { type: TUTORIAL_MARKER_TYPE, payload: { moduleId, turn } };
}

function questFor(
  mod: TutorialModule,
  turn: number,
  userId: string,
  sessionId: string,
  sheetFileId: string | undefined,
  at: Date
): TutorialQuest {
  const t = mod.transcript[turn];
  return {
    sessionId,
    timestamp: at,
    type: 'message',
    prompt: t.prompt,
    reply: t.reply,
    replies: [t.reply],
    status: 'done',
    ...(t.attachSheet && sheetFileId ? { fabFileIds: [sheetFileId] } : {}),
    ...(t.toolResults?.length ? { toolResults: t.toolResults } : {}),
    uiSideEffects: [...(t.uiSideEffects ?? []), markerOf(mod.id, turn)],
    promptMeta: { session: { id: sessionId, userId } },
  };
}

function markedTurn(quest: TutorialQuest, moduleId: string): number | undefined {
  for (const e of quest.uiSideEffects ?? []) {
    const p = e.payload as { moduleId?: unknown; turn?: unknown } | undefined;
    if (e.type === TUTORIAL_MARKER_TYPE && p?.moduleId === moduleId && typeof p.turn === 'number') return p.turn;
  }
  return undefined;
}

function carriesMarker(quest: TutorialQuest, moduleId: string, turn: number): boolean {
  return markedTurn(quest, moduleId) === turn;
}

/**
 * The canvas rides the quest it is recorded beside, covering every seeded quest up to it. That quest
 * may not carry its marker yet: a user's own message is marked only when its reply is saved.
 */
async function seedCanvas(
  deps: TutorialTurnDeps,
  mod: TutorialModule,
  userId: string,
  quest: { sessionId: string; id?: string },
  turn: number
): Promise<void> {
  const { canvas } = mod;
  if (!deps.canvas || canvas?.turn !== turn) return;
  if (!quest.id) throw new Error('Seeded tutorial quest has no id');
  const covered = (await deps.quests.findAllBySessionId(quest.sessionId))
    .map(q => ({ id: q.id, at: markedTurn(q, mod.id) }))
    .filter((q): q is { id: string; at: number } => !!q.id && q.at !== undefined && q.at <= turn)
    .sort((a, b) => a.at - b.at)
    .map(q => q.id);
  await deps.canvas.seed({
    sessionId: quest.sessionId,
    questId: quest.id,
    userId,
    coversQuestIds: covered.includes(quest.id) ? covered : [...covered, quest.id],
    label: canvas.label,
    addedIds: canvas.addedIds,
    doc: canvas.doc,
  });
}

/**
 * A restart supersedes the module's previous session. An unfinished one holding only recorded turns goes,
 * so the sidebar keeps at most one untouched session per module. One the user finished, left, or wrote in, stays.
 * Best effort: a failed check or delete keeps the session and never fails the restart.
 */
async function discardUntouchedSession(
  deps: TutorialDeps,
  userId: string,
  moduleId: string,
  prior: ITutorialModuleProgress | undefined,
  current: string
): Promise<void> {
  if (!prior || prior.status !== 'in_progress' || prior.sessionId === current) return;
  try {
    if (!(await deps.ownsSession(prior.sessionId, userId))) return;
    const quests = await deps.quests.findAllBySessionId(prior.sessionId);
    // An unmarked quest is the user's own message, or one still waiting for its reply.
    if (quests.some(q => markedTurn(q, moduleId) === undefined)) return;
    await deps.deleteSession(prior.sessionId, userId);
  } catch (error) {
    deps.warn(`tutorial: kept superseded session ${prior.sessionId}: ${String(error)}`);
  }
}

/**
 * Starts the module, or restarts it: a fresh, empty session each time. The previous one is left
 * where it is unless it holds nothing of the user's own (`discardUntouchedSession`).
 * The user sends the opening message themselves, and `answerTurn` replies to it as turn 0.
 */
export async function startModule(
  deps: TutorialDeps,
  userId: string,
  moduleId: string
): Promise<TutorialResult<{ sessionId: string; turn: -1; version: number; revision: number }>> {
  const mod = deps.modules.find(m => m.id === moduleId && m.enabled);
  if (!mod || mod.transcript.length === 0) return fail(404, 'Unknown tutorial module');

  // In the user's files before they reach the step that has them attach it.
  if (mod.sheet) await deps.ensureSheet(userId, mod, { toTop: true });
  const prior = await deps.progress.read(userId, moduleId);
  const session = await deps.createSession(mod);
  const at = deps.now();
  await deps.progress.begin(userId, moduleId, {
    status: 'in_progress',
    sessionId: session.id,
    turn: -1,
    moduleVersion: mod.version,
    moduleRevision: mod.revision,
    turnClaimedAt: at,
    updatedAt: at,
  });
  // Not best effort: an unmarked session would be answered by the model, so a failed mark fails the start.
  await deps.setSessionMarker?.(session.id, userId, moduleId);
  await discardUntouchedSession(deps, userId, moduleId, prior, session.id);
  return { ok: true, sessionId: session.id, turn: -1, version: mod.version, revision: mod.revision };
}

/**
 * Picks the module up in the session it already has, running again. Refused when that session is gone,
 * the module changed or finished, or a left session holds a message of the user's own, which made the
 * conversation theirs: the caller then starts the module fresh.
 */
export async function resumeModule(
  deps: TutorialDeps,
  userId: string,
  moduleId: string
): Promise<TutorialResult<{ sessionId: string; version: number; revision: number }>> {
  const mod = deps.modules.find(m => m.id === moduleId && m.enabled);
  if (!mod || mod.steps.length === 0) return fail(404, 'Unknown tutorial module');
  const entry = await deps.progress.read(userId, moduleId);
  if (!entry) return fail(404, 'No tutorial to resume', 'NOT_STARTED');
  if (!walkIsCurrent(entry, mod)) return fail(409, 'Tutorial was updated, start over', 'VERSION_CHANGED');
  if (entry.status === 'finished') return fail(409, 'Tutorial already finished', 'FINISHED');
  if (!(await deps.ownsSession(entry.sessionId, userId))) return fail(404, 'Tutorial session is gone', 'SESSION_GONE');
  if (entry.status === 'left') {
    if (!entry.stepId || entry.stepId === BRIDGE_STEP_ID) return fail(409, 'Tutorial already finished', 'FINISHED');
    const quests = await deps.quests.findAllBySessionId(entry.sessionId);
    if (quests.some(q => markedTurn(q, moduleId) === undefined)) {
      return fail(409, 'Tutorial session holds your own messages', 'SESSION_TOUCHED');
    }
  }
  const stepId = entry.stepId && mod.steps.some(s => s.id === entry.stepId) ? entry.stepId : mod.steps[0].id;
  if (!(await deps.progress.setPosition(userId, moduleId, stepId, 'in_progress', deps.now()))) {
    return fail(404, 'No tutorial to resume', 'NOT_STARTED');
  }
  return { ok: true, sessionId: entry.sessionId, version: mod.version, revision: mod.revision };
}

export async function moduleSheet(
  deps: TutorialDeps,
  userId: string,
  moduleId: string
): Promise<TutorialResult<{ fileId: string }>> {
  const mod = deps.modules.find(m => m.id === moduleId && m.enabled);
  if (!mod?.sheet) return fail(404, 'Unknown tutorial module');
  return { ok: true, fileId: await deps.ensureSheet(userId, mod) };
}

/**
 * Inserts recorded quest `turn`. Idempotent: the claim moves the turn counter once, and a retry
 * that finds the turn already claimed returns the quest it left. If the first attempt died between
 * the claim and the insert, one retry wins a lease on the claim and inserts it. A turn is never
 * claimed while the quest before it is missing, so quests cannot land out of order.
 */
export async function advanceModule(
  deps: TutorialDeps,
  userId: string,
  input: { moduleId: string; sessionId: string; turn: number }
): Promise<TutorialResult<{ quest: TutorialQuest; turn: number }>> {
  const { moduleId, sessionId, turn } = input;
  const mod = deps.modules.find(m => m.id === moduleId && m.enabled);
  if (!mod) return fail(404, 'Unknown tutorial module');
  if (!Number.isInteger(turn) || turn < 0 || turn >= mod.transcript.length) return fail(400, 'Turn out of range');

  const entry = await deps.progress.read(userId, moduleId);
  if (!entry || entry.sessionId !== sessionId || !(await deps.ownsSession(sessionId, userId))) {
    return fail(403, 'Not your tutorial session');
  }
  if (!walkIsCurrent(entry, mod)) return fail(409, 'Tutorial was updated, start over', 'VERSION_CHANGED');
  if (entry.status === 'finished') return fail(409, 'Tutorial already finished', 'FINISHED');
  if (entry.status !== 'in_progress') return fail(409, 'Tutorial is not running', 'NOT_RUNNING');

  const findQuest = async (n: number) =>
    (await deps.quests.findAllBySessionId(sessionId)).find(q => carriesMarker(q, moduleId, n));
  // Every path that hands back this turn's quest seeds its canvas, so a retry repairs a write that failed.
  const done = async (quest: TutorialQuest) => {
    await seedCanvas(deps, mod, userId, quest, turn);
    return { ok: true as const, turn, quest };
  };
  const landed = await findQuest(turn);
  if (landed) return done(landed);
  if (turn > 0 && !(await findQuest(turn - 1))) return fail(409, 'Turn out of order', 'OUT_OF_ORDER');

  const sheetFileId = mod.transcript[turn].attachSheet && mod.sheet ? await deps.ensureSheet(userId, mod) : undefined;
  const at = deps.now();
  const insert = async () => done(await deps.quests.create(questFor(mod, turn, userId, sessionId, sheetFileId, at)));

  if (await deps.progress.claimTurn(userId, moduleId, sessionId, turn - 1, turn, at)) return insert();

  const current = await deps.progress.read(userId, moduleId);
  if (!current || current.sessionId !== sessionId) return fail(403, 'Not your tutorial session');
  if (current.turn !== turn) return fail(409, 'Turn out of order', 'OUT_OF_ORDER');

  const inFlight = () => fail(409, 'Turn is being inserted', 'IN_FLIGHT');
  if (at.getTime() - current.turnClaimedAt.getTime() < TURN_INSERT_GRACE_MS) return inFlight();
  if (!(await deps.progress.reclaimTurn(userId, moduleId, sessionId, turn, current.turnClaimedAt, at))) {
    return inFlight();
  }
  // A slow first insert can land between the scan above and the lease.
  const late = await findQuest(turn);
  return late ? done(late) : insert();
}

type ScriptedTurn =
  | { stale: false; mod: TutorialModule; entry: ITutorialModuleProgress; from: number; turn: number }
  // The module changed or was switched off under a running walk.
  | { stale: true; off: boolean; moduleId: string; entry: ITutorialModuleProgress };

async function scriptedTurnOf(
  deps: TutorialTurnDeps,
  userId: string,
  sessionId: string
): Promise<ScriptedTurn | undefined> {
  for (const [moduleId, entry] of Object.entries(await deps.progress.all(userId))) {
    if (entry.sessionId !== sessionId || entry.status !== 'in_progress') continue;
    const mod = deps.modules.find(m => m.id === moduleId && m.enabled);
    if (!mod || !walkIsCurrent(entry, mod)) return { stale: true, off: !mod, moduleId, entry };
    const turn = entry.turn + 1;
    return turn < mod.transcript.length ? { stale: false, mod, entry, from: entry.turn, turn } : undefined;
  }
  return undefined;
}

/**
 * Whether this session still has recorded turns, so an agent run must not answer one. A walk whose module
 * changed under it has none left: its next message gets the updated reply, and agent runs go ahead.
 */
export async function sessionIsScripted(deps: TutorialTurnDeps, userId: string, sessionId: string): Promise<boolean> {
  const scripted = await scriptedTurnOf(deps, userId, sessionId);
  return scripted !== undefined && !scripted.stale;
}

/**
 * Answers the user's message with the module's next recorded reply when it is that turn's prompt.
 * Null lets the model answer: the session holds no tutorial, the user left it, its script has run
 * out, or the user asked something of their own, which ends the walk.
 */
export async function answerTurn(
  deps: TutorialTurnDeps,
  userId: string,
  sessionId: string,
  quest: { id: string; prompt: string }
): Promise<TutorialTurnReply | null> {
  const scripted = await scriptedTurnOf(deps, userId, sessionId);
  if (!scripted) return null;
  if (scripted.stale) {
    // Said once: the walk is left, so the next message is the model's. No marker, so no turn is spent.
    await deps.progress.setPosition(userId, scripted.moduleId, scripted.entry.stepId ?? '', 'left', deps.now());
    return { replies: [scripted.off ? TUTORIAL_OFF_REPLY : TUTORIAL_UPDATED_REPLY], uiSideEffects: [] };
  }
  const { mod, entry, from, turn } = scripted;
  if (!samePrompt(quest.prompt, mod.transcript[turn].prompt)) {
    // Recorded here as well as by the page, which may be closed, so agent runs stop being refused.
    await deps.progress.setPosition(userId, mod.id, entry.stepId ?? '', 'left', deps.now());
    return null;
  }
  const questId = quest.id;
  // Seeded before the claim so a failed seed cannot spend the turn. A concurrent duplicate that loses the
  // claim leaves its own copy of this turn's canvas row behind.
  await seedCanvas(deps, mod, userId, { sessionId, id: questId }, turn);
  if (!(await deps.progress.claimTurn(userId, mod.id, sessionId, from, turn, deps.now()))) {
    throw new Error('Another message already took this tutorial turn');
  }
  const t = mod.transcript[turn];
  return {
    replies: [t.reply],
    ...(t.toolResults?.length ? { toolResults: t.toolResults } : {}),
    uiSideEffects: [...(t.uiSideEffects ?? []), markerOf(mod.id, turn)],
  };
}

/**
 * Records where the user stands. A walk still running is refused once its module was switched off (410) or
 * changed since it started (409), so the page can end it; leaving or finishing is always recorded.
 */
export async function recordPosition(
  deps: TutorialDeps,
  userId: string,
  input: { moduleId: string; stepId: string; status: TutorialModuleStatus; version?: number; revision?: number }
): Promise<TutorialResult<{ moduleId: string }>> {
  const mod = deps.modules.find(m => m.id === input.moduleId);
  if (!mod) return fail(404, 'Unknown tutorial step');
  if (input.status === 'in_progress') {
    if (!mod.enabled) return fail(410, 'Tutorial was switched off', 'MODULE_OFF');
    const changed =
      (input.version !== undefined && input.version !== mod.version) ||
      (input.revision !== undefined && input.revision !== mod.revision);
    if (changed) return fail(409, 'Tutorial was updated, start over', 'VERSION_CHANGED');
  }
  if (!mod.steps.some(s => s.id === input.stepId)) return fail(404, 'Unknown tutorial step');
  const walking = input.status === 'in_progress' ? undefined : await deps.progress.read(userId, input.moduleId);
  const updated = await deps.progress.setPosition(userId, input.moduleId, input.stepId, input.status, deps.now());
  if (updated && walking) await markSession(deps, walking.sessionId, userId, null);
  return updated ? { ok: true, moduleId: input.moduleId } : fail(404, 'No tutorial in progress');
}

/** The enabled modules, client fields only: nothing about who overrode what, or why. */
export function enabledModules(modules: readonly TutorialModule[]): TutorialRunModule[] {
  return modules
    .filter(m => m.enabled)
    .map(({ id, title, pitch, version, revision, enabled, steps, canvasSolve, created }) => ({
      id,
      title,
      pitch,
      version,
      revision,
      enabled,
      steps,
      ...(canvasSolve && { canvasSolve }),
      ...(created && { created }),
    }));
}

export async function readProgress(
  deps: TutorialDeps,
  userId: string
): Promise<{ modules: Record<string, ITutorialModuleProgress> }> {
  return { modules: await deps.progress.all(userId) };
}

export { TUTORIAL_MARKER_TYPE };

export interface TutorialServiceDeps {
  ensureSheet: TutorialDeps['ensureSheet'];
  createSession: TutorialDeps['createSession'];
  ownsSession: TutorialDeps['ownsSession'];
  deleteSession: TutorialDeps['deleteSession'];
  canvas?: TutorialDeps['canvas'];
  quests?: TutorialDeps['quests'];
  now?: () => Date;
  warn?: (message: string) => void;
  setSessionMarker?: TutorialDeps['setSessionMarker'];
}

export interface TutorialServiceOptions {
  /** The modules this caller may run, overrides applied. Anything left out answers as an unknown id. */
  modules: readonly TutorialModule[];
  models: Pick<TutorialModels, 'Progress'>;
  deps: TutorialServiceDeps;
}

/** What the chat path needs: the turn answers, with no sheet, session or marker deps. */
export function tutorialTurnService({
  modules,
  models,
  quests,
  now,
}: {
  modules: readonly TutorialModule[];
  models: Pick<TutorialModels, 'Progress'>;
  quests?: TutorialServiceDeps['quests'];
  now?: () => Date;
}) {
  const deps: TutorialTurnDeps = {
    modules,
    progress: progressStoreFor(models.Progress),
    quests: quests ?? defaultQuests,
    now: now ?? (() => new Date()),
  };
  return {
    answerTurn: (userId: string, sessionId: string, quest: { id: string; prompt: string }) =>
      answerTurn(deps, userId, sessionId, quest),
    sessionIsScripted: (userId: string, sessionId: string) => sessionIsScripted(deps, userId, sessionId),
  };
}

const defaultQuests: NonNullable<TutorialServiceDeps['quests']> = {
  create: async quest => (await questRepository.create(quest as never)) as unknown as TutorialQuest,
  findAllBySessionId: async sessionId =>
    (await questRepository.findAllBySessionId(sessionId)) as unknown as TutorialQuest[],
};

/** One caller's view of an owner's tutorials: the route actions and the chat path's turn answers. */
export function tutorialService({ modules, models, deps: injected }: TutorialServiceOptions) {
  const deps: TutorialDeps = {
    modules,
    progress: progressStoreFor(models.Progress),
    quests: injected.quests ?? defaultQuests,
    canvas: injected.canvas,
    ensureSheet: injected.ensureSheet,
    createSession: injected.createSession,
    ownsSession: injected.ownsSession,
    deleteSession: injected.deleteSession,
    now: injected.now ?? (() => new Date()),
    warn: injected.warn ?? (() => {}),
    setSessionMarker: injected.setSessionMarker,
  };
  return {
    deps,
    modules: () => enabledModules(modules),
    progress: async (userId: string) => {
      const { modules: entries } = await readProgress(deps, userId);
      const known = new Set(modules.map(m => m.id));
      return { modules: Object.fromEntries(Object.entries(entries).filter(([id]) => known.has(id))) };
    },
    start: (userId: string, moduleId: string) => startModule(deps, userId, moduleId),
    resume: (userId: string, moduleId: string) => resumeModule(deps, userId, moduleId),
    sheet: (userId: string, moduleId: string) => moduleSheet(deps, userId, moduleId),
    advance: (userId: string, input: Parameters<typeof advanceModule>[2]) => advanceModule(deps, userId, input),
    position: (userId: string, input: Parameters<typeof recordPosition>[2]) => recordPosition(deps, userId, input),
    answerTurn: (userId: string, sessionId: string, quest: { id: string; prompt: string }) =>
      answerTurn(deps, userId, sessionId, quest),
    sessionIsScripted: (userId: string, sessionId: string) => sessionIsScripted(deps, userId, sessionId),
  };
}

export type TutorialService = ReturnType<typeof tutorialService>;
