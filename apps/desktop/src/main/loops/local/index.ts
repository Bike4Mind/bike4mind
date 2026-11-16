import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, app, ipcMain, powerMonitor, powerSaveBlocker } from 'electron';
import { z } from 'zod';
import { BadRequestError, LOOP_DIRECTIVE_TRANSITIONS, startOfUtcDay } from '@bike4mind/common';
import { UNSURE_PREFIX } from '@bike4mind/common/loops';
import { IPC_CHANNELS } from '@shared/ipc';
import { loopNeedsYouCount } from '@shared/needsYou';
import {
  answerLocalEventSchema,
  overrideLocalDirectiveSchema,
  createLocalLoopSchema,
  createLocalTicketSchema,
  setLocalBudgetSchema,
  setLocalLoopStatusSchema,
  updateLocalLoopSchema,
  updateLocalTicketSchema,
  type LocalLoop,
  type LocalLoopDetail,
  type LocalLoopsResult,
  type LocalLoopSummary,
} from '@shared/localLoops';
import type { AuthService } from '../../auth/AuthService';
import { onAuthStateChanged } from '../../auth';
import type { ChatService } from '../../chat/ChatService';
import { pickDirectory } from '../../chat';
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
import { checkedFields } from './fields';
import { LocalLoopScheduler } from './LocalLoopScheduler';
import { LoopMirror, MIRROR_MS } from './mirror';
import { applyTicketPatch, LocalLoopStore } from './LocalLoopStore';
import { createTicket, updateTicket } from './ticketTools';
import { WATCHDOG_MS } from './watchdog';

const ALL_LOOPS_CAP = 'allLoopsCap';
const CLOUD_SPENT = 'cloudLoopsSpent';
const BUDGET_PATH = '/api/loops/budget';
/** How old the cached web-loop spend may get before a tick refetches it (ms). */
const BUDGET_TTL_MS = 5 * 60_000;

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
  const listeners: (() => void)[] = [];
  const push = (loopId?: string) => {
    if (loopId) changed.add(loopId);
    pushTimer ??= setTimeout(() => {
      pushTimer = undefined;
      const loopIds = [...changed];
      changed.clear();
      for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.localLoopsChanged, { loopIds });
      for (const listener of listeners) listener();
      mirror.changed();
    }, 50);
  };

  // The store's scope moves only once the old account's runs are released (follow), so their ends land there.
  let currentScope = scope();
  let store: LocalLoopStore;
  try {
    store = new LocalLoopStore(join(app.getPath('userData'), 'local-loops.sqlite'), () => currentScope, push);
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
    cloudLoopsSpentToday: now => {
      if (Date.now() - budgetRefreshedAt > BUDGET_TTL_MS) void refreshBudget();
      const cached = store.setting<{ day: string; credits: number }>(CLOUD_SPENT);
      // Offline keeps the last value for the same UTC day; a new day starts at 0.
      return cached?.day === startOfUtcDay(now).toISOString() ? cached.credits : 0;
    },
    gh: runGh,
    github: new PrGithub(runGh),
    powerSaveBlocker,
    alert: (loop, event) => {
      // A lifted cap, a wake or a relaunch re-queue: the board and Activity show it, no notice.
      if (event.kind === 'auto_resumed' || event.kind === 'requeued') return;
      if (!Notification.isSupported() || appWindows().some(window => window.isFocused())) return;
      new Notification({ title: `${loop.name}: ${event.kind}`, body: event.reason, silent: true }).show();
    },
    onChange: () => push(),
    logger,
  });

  /** The all-loops budget and today's web-loop spend, cached so an offline Desktop keeps the last known values. */
  let budgetRefreshedAt = 0;
  const refreshBudget = async () => {
    const api = auth.getApiClient();
    if (!api || !currentScope) return;
    budgetRefreshedAt = Date.now();
    const asked = currentScope;
    const day = startOfUtcDay(new Date()).toISOString();
    const body = await api.get<{ effectiveCap?: number | null; creditsToday?: number }>(BUDGET_PATH).catch(() => null);
    // An account switch during the fetch: these numbers belong to the previous account.
    if (!body || currentScope !== asked) return;
    store.setSetting(ALL_LOOPS_CAP, body.effectiveCap ?? null);
    if (typeof body.creditsToday === 'number') store.setSetting(CLOUD_SPENT, { day, credits: body.creditsToday });
  };

  // Read-only status for the web Loops page; on by default per loop (LocalLoop.mirror).
  const mirror = new LoopMirror({
    api: () => (currentScope ? auth.getApiClient() : null),
    details: () => store.loops().map(loop => detail(loop.id)),
    logger,
  });
  setInterval(() => void mirror.flush(), MIRROR_MS.heartbeat);

  const follow = () => {
    currentScope = scope();
    mirror.reset();
    if (currentScope) {
      scheduler.start();
      void refreshBudget().then(() => scheduler.poke());
    } else scheduler.stop();
    push();
  };
  onAuthStateChanged(() => {
    if (scope() === currentScope) return;
    void scheduler
      .releaseAll()
      .catch(err => logger.warn(`LOOPS: releasing runs failed: ${String(err)}`))
      .finally(follow);
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
      directives: store.directives(id).slice(0, 50),
    };
  };
  const loopIds = () => new Set(store.loops().map(loop => loop.id));
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

  // Folders the owner chose in the native picker this run; create/update take a directory only from here.
  const pickedFolders = new Set<string>();
  ipcMain.handle(
    IPC_CHANNELS.localLoopsPickFolder,
    async (event): Promise<LocalLoopsResult<{ directory: string } | null>> => {
      const directory = await pickDirectory(event.sender).catch((err: unknown) => {
        logger.warn(`LOOPS: folder picker failed: ${String(err)}`);
        return undefined;
      });
      if (directory === undefined) return { ok: false, error: 'The folder picker could not open.' };
      if (directory === null) return { ok: true, value: null };
      if (!existsSync(join(directory, '.git'))) return { ok: false, error: 'Pick a local git checkout.' };
      pickedFolders.add(directory);
      return { ok: true, value: { directory } };
    }
  );
  handle(IPC_CHANNELS.localLoopsList, () => summaries());
  const idOf = (input: unknown) => z.string().min(1).parse(input);
  handle(IPC_CHANNELS.localLoopsGet, input => detail(idOf(input)));
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
      ...(checkedFields(request, undefined, pickedFolders, loopIds()) as Pick<
        LocalLoop,
        'name' | 'goal' | 'stages' | 'model' | 'directory'
      >),
    };
    const repo = repoSlug(await originOf(loop.directory));
    store.putLoop({ ...loop, ...(repo ? { repo } : {}) });
    return detail(loop.id);
  });
  handle(IPC_CHANNELS.localLoopsUpdateLoop, async input => {
    const { id, ...request } = updateLocalLoopSchema.parse(input);
    // Validated before git runs in the requested folder; the real check is redone on the fresh read below.
    checkedFields(request, loopOf(id), pickedFolders, loopIds());
    // Resolved before the read, so the write below cannot undo what the scheduler stored meanwhile.
    const repo = request.directory !== undefined ? repoSlug(await originOf(request.directory)) : undefined;
    const current = loopOf(id);
    const next = {
      ...current,
      ...checkedFields(request, current, pickedFolders, loopIds()),
      updatedAt: new Date().toISOString(),
    };
    // A new budget answers a budget cap: lift it, and the next pass caps again if spend is still over.
    if (request.budgetCreditsPerDay !== undefined && next.capReason === 'loop_budget') {
      delete next.cappedUntil;
      delete next.capReason;
    }
    if (request.directory !== undefined) {
      if (repo) next.repo = repo;
      else delete next.repo;
    }
    store.putLoop(next);
    scheduler.poke();
    return detail(id);
  });
  handle(IPC_CHANNELS.localLoopsDeleteLoop, input => {
    const id = idOf(input);
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
    const id = idOf(input);
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
  handle(IPC_CHANNELS.localLoopsUpdateTicket, async input => {
    const { id, delete: remove, ...fields } = updateLocalTicketSchema.parse(input);
    const ticket = store.ticket(id);
    if (!ticket) throw new BadRequestError('Ticket not found.');
    if (remove) {
      if (ticket.status === 'in_progress') throw new BadRequestError('A run is working this ticket.');
      store.deleteTicket(ticket);
      return null;
    }
    const updated = store.transaction(() => updateTicket(store, loopOf(ticket.loopId), ticket, fields, 'owner'));
    // Closed, blocked or reopened by the owner while a run works it: that run stops, uncounted.
    // The owner's change is already stored, so a failed stop is logged rather than reported as a refused move.
    if (ticket.status === 'in_progress' && updated.status !== 'in_progress')
      await scheduler
        .stopTicketRun(id)
        .catch(err => logger.warn(`LOOPS: stopping the run of ticket ${id} failed: ${String(err)}`));
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
  handle(IPC_CHANNELS.localLoopsOverrideDirective, input => {
    const { id, action, note } = overrideLocalDirectiveSchema.parse(input);
    const directive = store.directive(id);
    if (!directive || directive.action) throw new BadRequestError('Directive not found.');
    if (!LOOP_DIRECTIVE_TRANSITIONS[action].includes(directive.state))
      throw new BadRequestError(`The directive is ${directive.state.replace('_', ' ')}.`);
    const at = new Date().toISOString();
    const trimmed = note?.trim();
    store.putDirective({
      ...directive,
      // Overruled goes back to open: the worker's next run sees it again, marked "owner insists".
      state: action === 'withdraw' ? 'withdrawn' : 'open',
      replies: [
        ...directive.replies,
        {
          by: 'owner',
          outcome: action === 'withdraw' ? 'withdrawn' : 'overruled',
          ...(trimmed && { note: trimmed }),
          at,
        },
      ],
      updatedAt: at,
    });
    scheduler.poke();
    return detail(directive.loopId);
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

  powerMonitor.on('suspend', () => scheduler.suspend(new Date()));
  powerMonitor.on('resume', () => scheduler.resume());
  setInterval(() => void scheduler.watchdog(), WATCHDOG_MS.interval);

  follow();
  return {
    scheduler,
    store,
    /** For main's dock badge while no window is open. */
    needsYouCount: () => loopNeedsYouCount(summaries()),
    onChanged: (listener: () => void) => void listeners.push(listener),
  };
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
  IPC_CHANNELS.localLoopsPickFolder,
  IPC_CHANNELS.localLoopsOverrideDirective,
];
