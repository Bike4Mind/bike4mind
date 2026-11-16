import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type { LocalLoopsResult } from '@shared/localLoops';
import type { LocalSchedulerDeps } from './LocalLoopScheduler';
import { testLoop } from './testLoop';
import { createTicket } from './ticketTools';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  userData: '',
  deps: null as LocalSchedulerDeps | null,
  stopTicketRun: vi.fn(async (_id: string) => undefined),
  pickDirectory: vi.fn(async (): Promise<string | null> => null),
  power: new Map<string, () => void>(),
  suspend: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, run: (event: unknown, input?: unknown) => unknown) => mocks.handlers.set(channel, run),
  },
  app: { getPath: () => mocks.userData },
  Notification: { isSupported: () => false },
  powerMonitor: { on: (event: string, listener: () => void) => mocks.power.set(event, listener) },
  powerSaveBlocker: {},
}));
vi.mock('../../chat', () => ({ pickDirectory: mocks.pickDirectory }));
vi.mock('../../chat/sessionScope', () => ({ sessionScopeForChat: () => ({}), sessionScopeKey: () => 'scope-1' }));
vi.mock('../../auth', () => ({ onAuthStateChanged: () => undefined }));
vi.mock('../../windows', () => ({ appWindows: () => [] }));
vi.mock('../../pr/gh', () => ({ runGh: vi.fn() }));
vi.mock('../../pr/github', () => ({ PrGithub: class {} }));
vi.mock('../index', () => ({ originOf: async () => '' }));
vi.mock('./LocalLoopScheduler', () => ({
  LocalLoopScheduler: class {
    constructor(deps: LocalSchedulerDeps) {
      mocks.deps = deps;
    }
    start() {}
    stop() {}
    poke() {}
    releaseAll = async () => undefined;
    stopTicketRun = mocks.stopTicketRun;
    suspend = mocks.suspend;
    resume = mocks.resume;
    summary = (loop: unknown) => ({ loop, lanesBusy: 0, spentToday: 0, needsYou: 0 });
  },
}));

const { registerLocalLoops } = await import('./index');

const call = async <T>(channel: string, input?: unknown) =>
  (await mocks.handlers.get(channel)!({ sender: {} }, input)) as LocalLoopsResult<T>;

function register(budget: { effectiveCap?: number | null; creditsToday?: number } = {}) {
  const get = vi.fn(async () => budget);
  const auth = { getState: () => ({ environment: { url: 'https://b4m.test' } }), getApiClient: () => ({ get }) };
  const registered = registerLocalLoops(auth as never, {} as never, {} as never, {} as never, {} as never);
  if (!registered) throw new Error('store did not open');
  return { ...registered, get };
}

describe('registerLocalLoops handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.userData = mkdtempSync(join(tmpdir(), 'b4m-local-loops-'));
    mocks.stopTicketRun.mockReset().mockResolvedValue(undefined);
    mocks.pickDirectory.mockReset();
  });

  function runningTicket() {
    const { store } = register();
    const loop = testLoop();
    store.putLoop(loop);
    return store.putTicket({ ...createTicket(store, loop, { title: 'a' }, 'owner'), status: 'in_progress' });
  }

  it('stops the run when the owner closes a running ticket, and not on a priority change', async () => {
    const ticket = runningTicket();
    expect(await call(IPC_CHANNELS.localLoopsUpdateTicket, { id: ticket.id, priority: 'p1' })).toMatchObject({
      ok: true,
    });
    expect(mocks.stopTicketRun).not.toHaveBeenCalled();
    const closed = await call(IPC_CHANNELS.localLoopsUpdateTicket, { id: ticket.id, status: 'closed' });
    expect(closed).toMatchObject({ ok: true, value: { status: 'closed' } });
    expect(mocks.stopTicketRun).toHaveBeenCalledWith(ticket.id);
  });

  it('still reports the stored close when stopping the run fails', async () => {
    mocks.stopTicketRun.mockRejectedValue(new Error('chat gone'));
    const ticket = runningTicket();
    expect(await call(IPC_CHANNELS.localLoopsUpdateTicket, { id: ticket.id, status: 'closed' })).toMatchObject({
      ok: true,
      value: { status: 'closed' },
    });
  });

  it('creates a loop only in a folder chosen in the picker', async () => {
    register();
    const directory = mkdtempSync(join(tmpdir(), 'b4m-repo-'));
    mkdirSync(join(directory, '.git'));
    const request = { name: 'Docs', goal: 'Keep the docs right', stages: ['todo', 'done'], model: 'm', directory };
    expect(await call(IPC_CHANNELS.localLoopsCreateLoop, request)).toEqual({
      ok: false,
      error: 'Choose the folder with Choose folder.',
    });
    mocks.pickDirectory.mockResolvedValue(directory);
    expect(await call(IPC_CHANNELS.localLoopsPickFolder)).toEqual({ ok: true, value: { directory } });
    expect(await call(IPC_CHANNELS.localLoopsCreateLoop, request)).toMatchObject({
      ok: true,
      value: { loop: { directory } },
    });
  });

  it('refuses a picked folder that is not a git checkout', async () => {
    register();
    mocks.pickDirectory.mockResolvedValue(mkdtempSync(join(tmpdir(), 'b4m-plain-')));
    expect(await call(IPC_CHANNELS.localLoopsPickFolder)).toEqual({ ok: false, error: 'Pick a local git checkout.' });
  });

  it('lets the owner overrule a push-back (back to open) and withdraw a directive, but not an action', async () => {
    const { store } = register();
    store.putLoop(testLoop());
    const base = {
      loopId: 'loop-1',
      fromLoopId: 'boss',
      fromLoopName: 'Boss',
      runId: 'r',
      instruction: 'x',
      reason: 'y',
      replies: [],
      createdAt: '',
      updatedAt: '',
    };
    store.putDirective({ ...base, id: 'd1', state: 'pushed_back' });
    store.putDirective({ ...base, id: 'd2', state: 'done', action: 'run_now' });
    expect(
      await call(IPC_CHANNELS.localLoopsOverrideDirective, { id: 'd1', action: 'overrule', note: 'Do it anyway' })
    ).toMatchObject({ ok: true });
    expect(store.directive('d1')).toMatchObject({
      state: 'open',
      replies: [{ by: 'owner', outcome: 'overruled', note: 'Do it anyway' }],
    });
    expect(await call(IPC_CHANNELS.localLoopsOverrideDirective, { id: 'd1', action: 'overrule' })).toEqual({
      ok: false,
      error: 'The directive is open.',
    });
    expect(await call(IPC_CHANNELS.localLoopsOverrideDirective, { id: 'd1', action: 'withdraw' })).toMatchObject({
      ok: true,
    });
    expect(store.directive('d1')?.state).toBe('withdrawn');
    expect(await call(IPC_CHANNELS.localLoopsOverrideDirective, { id: 'd2', action: 'withdraw' })).toEqual({
      ok: false,
      error: 'Directive not found.',
    });
  });

  it('holds the scheduler while the machine sleeps and wakes it on resume', () => {
    register();
    mocks.power.get('suspend')!();
    expect(mocks.suspend).toHaveBeenCalledWith(expect.any(Date));
    mocks.power.get('resume')!();
    expect(mocks.resume).toHaveBeenCalled();
  });

  it('counts the cached web-loop spend for the same UTC day only', async () => {
    register({ effectiveCap: 500, creditsToday: 40 });
    await call(IPC_CHANNELS.localLoopsGetBudget);
    const now = new Date();
    expect(mocks.deps!.cloudLoopsSpentToday(now)).toBe(40);
    expect(mocks.deps!.cloudLoopsSpentToday(new Date(now.getTime() + 24 * 60 * 60_000))).toBe(0);
  });
});
