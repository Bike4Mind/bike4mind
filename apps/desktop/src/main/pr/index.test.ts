import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrChatHooks } from './PrMonitor';
import { registerPullRequests } from './index';

const captured = vi.hoisted(() => ({ chat: null as PrChatHooks | null }));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../chat/project/git', () => ({ currentBranch: vi.fn() }));
vi.mock('./PrMonitor', () => ({
  PrMonitor: class {
    constructor(options: { chat: PrChatHooks }) {
      captured.chat = options.chat;
    }
    start = async () => undefined;
  },
}));

const { currentBranch } = await import('../chat/project/git');

const SESSION = 'session-1';
const WORKING_DIRECTORY = '/repo/worktree';

type StoredSession = { mode: string; project?: { workingDirectory: string; workspaceBranch?: string } } | null;

function register(session: StoredSession): PrChatHooks {
  registerPullRequests({
    path: '/unused',
    autoFixAttemptsPath: '/unused-attempts',
    chat: () => {
      throw new Error('not used');
    },
    store: { get: async () => session } as never,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    send: vi.fn(),
  });
  if (!captured.chat) throw new Error('hooks not captured');
  return captured.chat;
}

function codeSession(workspaceBranch?: string): StoredSession {
  return { mode: 'code', project: { workingDirectory: WORKING_DIRECTORY, workspaceBranch } };
}

describe('registerPullRequests project hook', () => {
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
