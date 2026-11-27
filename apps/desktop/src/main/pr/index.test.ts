import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrChatHooks } from './PrMonitor';
import { registerPullRequests } from './index';
import { IPC_CHANNELS } from '@shared/ipc';
import { ipcMain } from 'electron';

const captured = vi.hoisted(() => ({ chat: null as PrChatHooks | null, getState: vi.fn() }));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../chat/project/git', () => ({ currentBranch: vi.fn() }));
vi.mock('./PrMonitor', () => ({
  PrMonitor: class {
    constructor(options: { chat: PrChatHooks }) {
      captured.chat = options.chat;
    }
    start = async () => undefined;
    getState = captured.getState;
  },
}));

const { currentBranch } = await import('../chat/project/git');

const SESSION = 'session-1';
const WORKING_DIRECTORY = '/repo/worktree';

type StoredSession = { mode: string; project?: { workingDirectory: string; workspaceBranch?: string } } | null;

type ChatApi = { setSessionArchived: (sessionId: string, archived: boolean) => Promise<unknown> };

function register(
  session: StoredSession,
  chat: () => ChatApi = () => {
    throw new Error('not used');
  },
  sessionSummary = vi.fn()
): PrChatHooks {
  registerPullRequests({
    path: '/unused',
    autoFixAttemptsPath: '/unused-attempts',
    chat: chat as never,
    store: { get: async () => session } as never,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    send: vi.fn(),
    sessionSummary,
  });
  if (!captured.chat) throw new Error('hooks not captured');
  return captured.chat;
}

function codeSession(workspaceBranch?: string): StoredSession {
  return { mode: 'code', project: { workingDirectory: WORKING_DIRECTORY, workspaceBranch } };
}

describe('registerPullRequests project hook', () => {
  it('validates the selected-session read without registering a watch', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    register(null);
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC_CHANNELS.prGetState)?.[1];
    expect(handler).toBeDefined();
    captured.getState.mockResolvedValue(null);
    expect(await handler!({} as never, undefined)).toBeNull();
    expect(await handler!({} as never, { sessionId: 'agent' })).toBeNull();
    expect(captured.getState).not.toHaveBeenCalled();
    await handler!({} as never, 'agent');
    expect(captured.getState).toHaveBeenCalledWith('agent');
  });
  beforeEach(() => {
    captured.chat = null;
    vi.mocked(currentBranch).mockReset();
  });

  it('prefers the checked-out branch when asked for the live one', async () => {
    vi.mocked(currentBranch).mockResolvedValue('checked-out');
    const hooks = register(codeSession('recorded'));
    expect(await hooks.project(SESSION, { live: true })).toEqual({
      workingDirectory: WORKING_DIRECTORY,
      branch: 'checked-out',
    });
    expect(currentBranch).toHaveBeenCalledWith(WORKING_DIRECTORY);
  });

  it('falls back to the recorded branch when the live checkout is unknown', async () => {
    vi.mocked(currentBranch).mockResolvedValue(null);
    const hooks = register(codeSession('recorded'));
    expect((await hooks.project(SESSION, { live: true }))?.branch).toBe('recorded');
  });

  it('falls back to the recorded branch when reading the checkout rejects', async () => {
    vi.mocked(currentBranch).mockRejectedValue(new Error('not a git repository'));
    const hooks = register(codeSession('recorded'));
    expect((await hooks.project(SESSION, { live: true }))?.branch).toBe('recorded');
  });

  it('prefers the recorded branch over the checkout when not live', async () => {
    vi.mocked(currentBranch).mockResolvedValue('checked-out');
    const hooks = register(codeSession('recorded'));
    expect((await hooks.project(SESSION))?.branch).toBe('recorded');
    expect(currentBranch).not.toHaveBeenCalled();
  });

  it('uses the checked-out branch when not live and none is recorded', async () => {
    vi.mocked(currentBranch).mockResolvedValue('checked-out');
    const hooks = register(codeSession());
    expect((await hooks.project(SESSION))?.branch).toBe('checked-out');
  });

  it('returns null for a session that is not code or has no project', async () => {
    expect(
      await register({ mode: 'chat', project: { workingDirectory: WORKING_DIRECTORY } }).project(SESSION)
    ).toBeNull();
    expect(await register({ mode: 'code' }).project(SESSION)).toBeNull();
    expect(await register(null).project(SESSION)).toBeNull();
  });
});

describe('registerPullRequests archive hook', () => {
  beforeEach(() => {
    captured.chat = null;
  });

  it('pushes the archived summary so the sidebar learns of it', async () => {
    const summary = { id: SESSION, archived: true };
    const setSessionArchived = vi.fn(async () => summary);
    const sessionSummary = vi.fn();
    const hooks = register(codeSession(), () => ({ setSessionArchived }), sessionSummary);
    await hooks.archive(SESSION);
    expect(setSessionArchived).toHaveBeenCalledWith(SESSION, true);
    expect(sessionSummary).toHaveBeenCalledWith(summary);
  });

  it('pushes nothing when the session is gone', async () => {
    const sessionSummary = vi.fn();
    const hooks = register(codeSession(), () => ({ setSessionArchived: async () => null }), sessionSummary);
    await hooks.archive(SESSION);
    expect(sessionSummary).not.toHaveBeenCalled();
  });
});
