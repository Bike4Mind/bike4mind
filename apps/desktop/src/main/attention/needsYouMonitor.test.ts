import type { AttentionNotice } from '@shared/attention';
import type { ChatMessage, ChatSessionSummary } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYouMonitor, type NeedsYouMonitorDeps } from './needsYouMonitor';

const at = '2026-10-01T00:00:00.000Z';
const session = (id: string, parentId?: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary =>
  ({
    id,
    title: `Session ${id}`,
    mode: 'code',
    messageCount: 0,
    createdAt: at,
    updatedAt: at,
    ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
    ...extra,
  }) as ChatSessionSummary;

const parked: ChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: at,
    toolCalls: [
      { id: 'c1', name: 'bash', input: { command: 'pnpm test' }, status: 'awaiting-approval', approvalId: 'a1' },
    ],
  } as ChatMessage,
];

let sessions: ChatSessionSummary[];
let hasWindow: boolean;
let notices: AttentionNotice[];
const setBadge = vi.fn<(count: number) => void>();
const claim = vi.fn<(sessionIds: readonly string[]) => string[]>();
let deps: NeedsYouMonitorDeps;
let monitor: NeedsYouMonitor;

beforeEach(() => {
  sessions = [session('root'), session('agent', 'root'), session('plain')];
  hasWindow = false;
  notices = [];
  setBadge.mockReset();
  claim.mockReset().mockImplementation(ids => [...ids]);
  deps = {
    listSessions: vi.fn(async () => sessions),
    sessionMessages: vi.fn(async () => parked),
    hasWindow: () => hasWindow,
    claim,
    notify: notice => notices.push(notice),
    setBadge,
    warn: vi.fn(),
  };
  monitor = new NeedsYouMonitor(deps);
});

const enter = async (sessionId: string) => {
  monitor.observe({ sessionId, status: 'needs-action' });
  await monitor.settled();
};

describe('NeedsYouMonitor with no window open', () => {
  it('announces an agent entering needs-action, named and described as the renderer would', async () => {
    await enter('agent');
    expect(notices).toEqual([
      { sessionId: 'agent', rootId: 'root', title: expect.stringMatching(/ needs you$/), body: 'bash pnpm test' },
    ]);
    expect(notices[0]?.title).not.toContain('Session agent');
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });

  it('announces once per entry, and again after the session left needs-action', async () => {
    await enter('agent');
    await enter('agent');
    expect(notices).toHaveLength(1);
    monitor.observe({ sessionId: 'agent', status: 'processing' });
    await enter('agent');
    expect(notices).toHaveLength(2);
  });

  it('names the parent by its title when the parent is the one waiting', async () => {
    await enter('root');
    expect(notices[0]).toMatchObject({ sessionId: 'root', rootId: 'root', title: 'Session root needs you' });
  });

  it('stays quiet for plain, archived and deleted sessions, and leaves them out of the badge', async () => {
    sessions = [...sessions, session('shelved', undefined, { archived: true }), session('under', 'shelved')];
    await enter('plain');
    await enter('under');
    await enter('gone');
    expect(notices).toEqual([]);
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });

  it('skips an entry another announcer already claimed, but still counts it', async () => {
    claim.mockReturnValue([]);
    await enter('agent');
    expect(notices).toEqual([]);
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });

  it('still announces, with the fallback body, when the session cannot be read', async () => {
    deps.sessionMessages = vi.fn(async () => {
      throw new Error('gone');
    });
    await enter('agent');
    expect(notices[0]?.body).toBe('Waiting for your answer');
  });

  it('drops an entry the session already left while the list was being read', async () => {
    monitor.observe({ sessionId: 'agent', status: 'needs-action' });
    monitor.observe({ sessionId: 'agent', status: 'processing' });
    await monitor.settled();
    expect(notices).toEqual([]);
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });

  it("clears the badge on sign-out, once the old account's sessions are no longer listed", async () => {
    await enter('agent');
    expect(setBadge).toHaveBeenLastCalledWith(1);
    sessions = [];
    monitor.scopeChanged();
    await monitor.settled();
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });

  it('recounts the badge when the last window closes, without announcing what was already waiting', async () => {
    hasWindow = true;
    monitor.observe({ sessionId: 'agent', status: 'needs-action' });
    hasWindow = false;
    monitor.windowsClosed();
    await monitor.settled();
    expect(setBadge).toHaveBeenLastCalledWith(1);
    expect(notices).toEqual([]);
  });

  it('keeps working after an update fails', async () => {
    deps.listSessions = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(sessions);
    await enter('agent');
    expect(deps.warn).toHaveBeenCalled();
    monitor.observe({ sessionId: 'agent', status: 'processing' });
    await enter('agent');
    expect(notices).toHaveLength(1);
  });
});

describe('NeedsYouMonitor with a window open', () => {
  beforeEach(() => {
    hasWindow = true;
  });

  it('leaves announcing and the badge to the renderer', async () => {
    await enter('agent');
    expect(notices).toEqual([]);
    expect(setBadge).not.toHaveBeenCalled();
    expect(deps.listSessions).not.toHaveBeenCalled();
  });

  it('leaves the badge alone on sign-out; the remounting chat recounts it', async () => {
    monitor.scopeChanged();
    await monitor.settled();
    expect(setBadge).not.toHaveBeenCalled();
  });

  it('stands down when a window opens while the list is being read', async () => {
    hasWindow = false;
    deps.listSessions = vi.fn(async () => {
      hasWindow = true;
      return sessions;
    });
    await enter('agent');
    expect(notices).toEqual([]);
    expect(setBadge).not.toHaveBeenCalled();
  });
});
