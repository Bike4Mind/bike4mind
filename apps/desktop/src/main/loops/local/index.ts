import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Notification, app, ipcMain, powerMonitor, powerSaveBlocker } from 'electron';
import { BadRequestError } from '@bike4mind/common';
import {
  UNSURE_PREFIX,
  validateLoopBudget,
  validateLoopGoal,
  validateLoopMaxConcurrent,
  validateLoopModel,
  validateLoopName,
  validateLoopStageConfig,
  validateLoopStages,
} from '@bike4mind/common/loops';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  answerLocalEventSchema,
  createLocalLoopSchema,
  createLocalTicketSchema,
  setLocalBudgetSchema,
  setLocalLoopStatusSchema,
  updateLocalLoopSchema,
  updateLocalTicketSchema,
  type CreateLocalLoopRequest,
  type LocalLoop,
  type LocalLoopDetail,
  type LocalLoopStageConfig,
  type LocalLoopsResult,
  type LocalLoopSummary,
} from '@shared/localLoops';
import type { AuthService } from '../../auth/AuthService';
import { onAuthStateChanged } from '../../auth';
import type { ChatService } from '../../chat/ChatService';
import { sessionScopeForChat, sessionScopeKey } from '../../chat/sessionScope';
import type { BackgroundProcessRegistry } from '../../chat/tools/BackgroundProcessRegistry';
import { createMainLogger } from '../../logger';
import { runGh } from '../../pr/gh';
import { PrGithub } from '../../pr/github';
import { appWindows } from '../../windows';
import { sampleMachine } from '../budget';
import { repoSlug } from '../guards';
import type { LoopPolicyStore } from '../LoopPolicyStore';
import type { LoopRunner } from '../LoopRunner';
import { originOf } from '../index';
import { LocalLoopScheduler } from './LocalLoopScheduler';
import { applyTicketPatch, LocalLoopStore } from './LocalLoopStore';
import { createTicket, updateTicket } from './ticketTools';

const ALL_LOOPS_CAP = 'allLoopsCap';
const BUDGET_PATH = '/api/loops/budget';

/** The stage overrides a Desktop loop keeps: no `runner` (every stage runs here), tools or repo hint. */
function stageConfigOf(value: unknown, stages: string[]): LocalLoopStageConfig[] {
  return (validateLoopStageConfig(value ?? [], stages) ?? []).map(
    ({ runner: _runner, tools: _tools, repoHint: _repoHint, ...entry }) => entry
  );
}

function checkedFields(request: Partial<CreateLocalLoopRequest>, current?: LocalLoop): Partial<LocalLoop> {
  const stages = request.stages !== undefined ? validateLoopStages(request.stages) : current?.stages;
  if (request.directory !== undefined && !existsSync(request.directory))
    throw new BadRequestError('That folder does not exist.');
  return {
    ...(request.name !== undefined && { name: validateLoopName(request.name) }),
    ...(request.goal !== undefined && { goal: validateLoopGoal(request.goal) }),
    ...(stages && { stages }),
    ...((request.stageConfig !== undefined || request.stages !== undefined) && {
      stageConfig: stageConfigOf(request.stageConfig ?? current?.stageConfig, stages ?? []),
    }),
    ...(request.model !== undefined && { model: validateLoopModel(request.model) }),
    ...(request.escalationModel !== undefined && { escalationModel: validateLoopModel(request.escalationModel) }),
    ...(request.fallbackModel !== undefined && { fallbackModel: validateLoopModel(request.fallbackModel) }),
    ...(request.maxConcurrent !== undefined && { maxConcurrent: validateLoopMaxConcurrent(request.maxConcurrent) }),
    ...(request.budgetCreditsPerDay !== undefined && {
      budgetCreditsPerDay: validateLoopBudget(request.budgetCreditsPerDay),
    }),
    ...(request.p2RunsPerDay !== undefined && { p2RunsPerDay: request.p2RunsPerDay }),
    ...(request.directory !== undefined && { directory: request.directory }),
    ...(request.approvalMode !== undefined && { approvalMode: request.approvalMode }),
    ...(request.mirror !== undefined && { mirror: request.mirror }),
  };
}

/**
 * Desktop-owned loops: the store, the scheduler, and the `localLoops:*` IPC. Call after registerChat and
 * registerLoopRunner, routing chat's `localLoopTickets` hook and the stream observer here. An unopenable store
 * leaves every handler answering with the error; the rest of the app is unaffected.
 */
export function registerLocalLoops(
  auth: AuthService,
  chat: ChatService,
  background: BackgroundProcessRegistry,
  runner: LoopRunner,
  policies: LoopPolicyStore
) {
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const scope = () => {
    const chatScope = sessionScopeForChat(auth.getState());
    return chatScope ? sessionScopeKey(chatScope) : null;
  };
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Set<string>();
  const push = (loopId?: string) => {
    if (loopId) changed.add(loopId);
    pushTimer ??= setTimeout(() => {
      pushTimer = undefined;
      const loopIds = [...changed];
      changed.clear();
      for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.localLoopsChanged, { loopIds });
    }, 50);
  };

  let store: LocalLoopStore;
  try {
    store = new LocalLoopStore(join(app.getPath('userData'), 'local-loops.sqlite'), scope, push);
  } catch (err) {
    const error = `Loops are unavailable: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`LOOPS: ${error}`);
    for (const channel of LOCAL_LOOP_HANDLERS) ipcMain.handle(channel, () => ({ ok: false, error }));
    return null;
  }

  const scheduler = new LocalLoopScheduler({
    store,
    chat,
    killSessionProcesses: sessionId => background.killSession(sessionId),
    machine: async () => {
      const env = auth.getState().environment.url;
      // ponytail: the home volume stands in for every repo's worktrees, as for LoopRunner.
      return { sample: await sampleMachine(homedir(), powerMonitor), settings: await policies.settings(env) };
    },
    otherLanes: () => runner.busy,
    allLoopsCap: () => store.setting<number | null>(ALL_LOOPS_CAP) ?? undefined,
    gh: runGh,
    github: new PrGithub(runGh),
    powerSaveBlocker,
    alert: (loop, event) => {
      if (!Notification.isSupported() || appWindows().some(window => window.isFocused())) return;
      new Notification({ title: `${loop.name}: ${event.kind}`, body: event.reason, silent: true }).show();
    },
    onChange: () => push(),
    logger,
  });

  /** The all-loops budget, cached so an offline Desktop keeps the last known value. */
  const refreshBudget = async () => {
    const api = auth.getApiClient();
    if (!api || !scope()) return;
    const body = await api.get<{ effectiveCap?: number | null }>(BUDGET_PATH).catch(() => null);
    if (body) store.setSetting(ALL_LOOPS_CAP, body.effectiveCap ?? null);
  };

  let currentScope = scope();
  const follow = () => {
    currentScope = scope();
    if (currentScope) {
      scheduler.start();
      void refreshBudget().then(() => scheduler.poke());
    } else scheduler.stop();
    push();
  };
  onAuthStateChanged(() => {
    if (scope() === currentScope) return;
    void scheduler.releaseAll().then(follow);
  });

  const summaries = (): LocalLoopSummary[] => store.loops().map(loop => scheduler.summary(loop));
  const detail = (id: string): LocalLoopDetail => {
    const loop = store.loop(id);
    if (!loop) throw new BadRequestError('Loop not found.');
    return {
      ...scheduler.summary(loop),
      tickets: store.tickets(id),
      runs: store.runs(id).slice(0, 200),
      events: store.events(id).slice(0, 200),
    };
  };
  const loopOf = (id: string): LocalLoop => {
    const loop = store.loop(id);
    if (!loop) throw new BadRequestError('Loop not found.');
    return loop;
  };

  const handle = <T>(channel: string, run: (input: unknown) => T | Promise<T>) =>
    ipcMain.handle(channel, async (_event, input: unknown): Promise<LocalLoopsResult<T>> => {
      try {
        const value = await run(input);
        return { ok: true, value };
      } catch (err) {
        if (err instanceof BadRequestError || (err instanceof Error && err.name === 'ZodError'))
          return { ok: false, error: err.message };
        logger.warn(`LOOPS: ${channel} failed: ${String(err)}`);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

  handle(IPC_CHANNELS.localLoopsList, () => summaries());
  handle(IPC_CHANNELS.localLoopsGet, input => detail(String(input)));
  handle(IPC_CHANNELS.localLoopsCreateLoop, async input => {
    const request = createLocalLoopSchema.parse(input);
    const now = new Date().toISOString();
    const loop: LocalLoop = {
      id: randomUUID(),
      stageConfig: [],
      maxConcurrent: 1,
      approvalMode: 'auto',
      mirror: true,
      status: 'paused',
      memory: { notes: '', nextAction: '' },
      errorStreak: 0,
      createdAt: now,
      updatedAt: now,
      ...(checkedFields(request) as Pick<LocalLoop, 'name' | 'goal' | 'stages' | 'model' | 'directory'>),
    };
    const repo = repoSlug(await originOf(loop.directory));
    store.putLoop({ ...loop, ...(repo ? { repo } : {}) });
    return detail(loop.id);
  });
  handle(IPC_CHANNELS.localLoopsUpdateLoop, async input => {
    const { id, ...request } = updateLocalLoopSchema.parse(input);
    const current = loopOf(id);
    const next = { ...current, ...checkedFields(request, current), updatedAt: new Date().toISOString() };
    if (request.directory !== undefined) {
      const repo = repoSlug(await originOf(next.directory));
      if (repo) next.repo = repo;
      else delete next.repo;
    }
    store.putLoop(next);
    scheduler.poke();
    return detail(id);
  });
  handle(IPC_CHANNELS.localLoopsDeleteLoop, input => {
    const id = String(input);
    if (scheduler.summary(loopOf(id)).lanesBusy > 0)
      throw new BadRequestError('Pause the loop and let its runs end first.');
    store.deleteLoop(id);
    return summaries();
  });
  handle(IPC_CHANNELS.localLoopsSetStatus, input => {
    const { id, status } = setLocalLoopStatusSchema.parse(input);
    const loop = loopOf(id);
    const { error: _error, ...rest } = loop;
    store.putLoop({
      ...rest,
      status,
      errorStreak: status === 'live' ? 0 : loop.errorStreak,
      updatedAt: new Date().toISOString(),
    });
    scheduler.poke();
    return detail(id);
  });
  handle(IPC_CHANNELS.localLoopsRunNow, input => {
    const id = String(input);
    if (loopOf(id).status !== 'live') throw new BadRequestError('Set the loop live first.');
    scheduler.poke();
    return detail(id);
  });
  handle(IPC_CHANNELS.localLoopsCreateTicket, input => {
    const { loopId, ...fields } = createLocalTicketSchema.parse(input);
    const ticket = store.transaction(() => createTicket(store, loopOf(loopId), fields, 'owner'));
    scheduler.poke();
    return ticket;
  });
  handle(IPC_CHANNELS.localLoopsUpdateTicket, input => {
    const { id, delete: remove, ...fields } = updateLocalTicketSchema.parse(input);
    const ticket = store.ticket(id);
    if (!ticket) throw new BadRequestError('Ticket not found.');
    if (remove) {
      if (ticket.status === 'in_progress') throw new BadRequestError('A run is working this ticket.');
      store.deleteTicket(ticket);
      return null;
    }
    const updated = store.transaction(() => updateTicket(store, loopOf(ticket.loopId), ticket, fields, 'owner'));
    scheduler.poke();
    return updated;
  });
  handle(IPC_CHANNELS.localLoopsAnswerEvent, input => {
    const { id, outcome, note } = answerLocalEventSchema.parse(input);
    const event = store.event(id);
    if (!event || event.kind !== 'asked' || event.resolution)
      throw new BadRequestError('Only an unanswered question can be answered.');
    if (outcome === 'answered' && !note?.trim()) throw new BadRequestError('An answer is required.');
    const at = new Date();
    store.transaction(() => {
      store.putEvent({
        ...event,
        resolution: { outcome, ...(note ? { note: note.trim() } : {}), at: at.toISOString() },
      });
      const ticket = event.ticketId ? store.ticket(event.ticketId) : null;
      // As the server's resolve route: only a ticket still parked on this question changes.
      if (ticket?.status !== 'blocked' || !ticket.statusReason?.startsWith(UNSURE_PREFIX)) return;
      store.putTicket(
        applyTicketPatch(
          ticket,
          outcome === 'answered'
            ? { status: 'open', statusReason: null }
            : { statusReason: `Rejected by owner${note ? `: ${note.trim()}` : ''}`.slice(0, 1000) },
          at
        )
      );
    });
    scheduler.poke();
    return detail(event.loopId);
  });
  handle(IPC_CHANNELS.localLoopsGetBudget, async () => {
    await refreshBudget();
    return { dailyCredits: store.setting<number | null>(ALL_LOOPS_CAP) ?? null };
  });
  handle(IPC_CHANNELS.localLoopsSetBudget, async input => {
    const { dailyCredits } = setLocalBudgetSchema.parse(input);
    const api = auth.getApiClient();
    if (!api) throw new BadRequestError('Sign in to change the all-loops budget.');
    const body = await api.put<{ effectiveCap?: number | null }>(BUDGET_PATH, { dailyCredits });
    store.setSetting(ALL_LOOPS_CAP, body.effectiveCap ?? null);
    scheduler.poke();
    return { dailyCredits: body.effectiveCap ?? null };
  });

  follow();
  return { scheduler, store };
}

const LOCAL_LOOP_HANDLERS = [
  IPC_CHANNELS.localLoopsList,
  IPC_CHANNELS.localLoopsGet,
  IPC_CHANNELS.localLoopsCreateLoop,
  IPC_CHANNELS.localLoopsUpdateLoop,
  IPC_CHANNELS.localLoopsDeleteLoop,
  IPC_CHANNELS.localLoopsSetStatus,
  IPC_CHANNELS.localLoopsRunNow,
  IPC_CHANNELS.localLoopsCreateTicket,
  IPC_CHANNELS.localLoopsUpdateTicket,
  IPC_CHANNELS.localLoopsAnswerEvent,
  IPC_CHANNELS.localLoopsGetBudget,
  IPC_CHANNELS.localLoopsSetBudget,
];
