import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCliStore, selectActiveBackgroundShells, selectCompletedBackgroundShells } from './index.js';
import type { PermissionResponse } from '../components';
import type { Session } from '../storage';
import type { ShellSession, ShellSessionStatus } from '@bike4mind/services/llm/tools/cliTools';

function makeSession(overrides?: Partial<Session['metadata']>): Session {
  return {
    id: 'session-1',
    name: 'Test session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'claude',
    messages: [],
    metadata: {
      totalTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      ...overrides,
    },
  };
}

describe('interactionMode cycle', () => {
  beforeEach(() => {
    useCliStore.setState({ interactionMode: 'normal' });
  });

  it('should default to normal', () => {
    expect(useCliStore.getState().interactionMode).toBe('normal');
  });

  it('should cycle normal -> auto-accept -> plan -> normal', () => {
    const { cycleInteractionMode } = useCliStore.getState();
    cycleInteractionMode();
    expect(useCliStore.getState().interactionMode).toBe('auto-accept');
    cycleInteractionMode();
    expect(useCliStore.getState().interactionMode).toBe('plan');
    cycleInteractionMode();
    expect(useCliStore.getState().interactionMode).toBe('normal');
  });

  it('setInteractionMode jumps to a specific mode', () => {
    useCliStore.getState().setInteractionMode('plan');
    expect(useCliStore.getState().interactionMode).toBe('plan');
    useCliStore.getState().setInteractionMode('normal');
    expect(useCliStore.getState().interactionMode).toBe('normal');
  });
});

describe('paste state', () => {
  beforeEach(() => {
    useCliStore.setState({
      inputValue: '',
      pastedContent: null,
      pastedLineCount: 0,
    });
  });

  it('setPastedContent stores content, line count, and sets inputValue', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    useCliStore.getState().setPastedContent(content, 5);

    const state = useCliStore.getState();
    expect(state.pastedContent).toBe(content);
    expect(state.pastedLineCount).toBe(5);
    expect(state.inputValue).toBe(content);
  });

  it('clearPaste clears all paste state and inputValue', () => {
    useCliStore.getState().setPastedContent('some content', 3);
    useCliStore.getState().clearPaste();

    const state = useCliStore.getState();
    expect(state.pastedContent).toBeNull();
    expect(state.pastedLineCount).toBe(0);
    expect(state.inputValue).toBe('');
  });

  it('clearInput also clears paste state', () => {
    useCliStore.getState().setPastedContent('pasted text', 2);
    useCliStore.getState().clearInput();

    const state = useCliStore.getState();
    expect(state.pastedContent).toBeNull();
    expect(state.pastedLineCount).toBe(0);
    expect(state.inputValue).toBe('');
  });
});

describe('recordSubagentUsage', () => {
  beforeEach(() => {
    useCliStore.setState({ session: null });
  });

  it('is a no-op when there is no active session', () => {
    useCliStore.getState().recordSubagentUsage({ tokens: 100, credits: 5 });
    expect(useCliStore.getState().session).toBeNull();
  });

  it('initializes and increments calls/tokens/credits on the first call', () => {
    useCliStore.setState({ session: makeSession() });

    useCliStore.getState().recordSubagentUsage({ tokens: 150, credits: 3 });

    const metadata = useCliStore.getState().session?.metadata;
    expect(metadata?.subagentCalls).toBe(1);
    expect(metadata?.subagentTokens).toBe(150);
    expect(metadata?.subagentCost).toBe(3);
  });

  it('accumulates across multiple calls', () => {
    useCliStore.setState({ session: makeSession() });

    useCliStore.getState().recordSubagentUsage({ tokens: 100, credits: 2 });
    useCliStore.getState().recordSubagentUsage({ tokens: 50, credits: 1 });

    const metadata = useCliStore.getState().session?.metadata;
    expect(metadata?.subagentCalls).toBe(2);
    expect(metadata?.subagentTokens).toBe(150);
    expect(metadata?.subagentCost).toBe(3);
  });

  it('treats undefined credits as 0 without producing NaN', () => {
    useCliStore.setState({ session: makeSession() });

    useCliStore.getState().recordSubagentUsage({ tokens: 42 });

    const metadata = useCliStore.getState().session?.metadata;
    expect(metadata?.subagentCalls).toBe(1);
    expect(metadata?.subagentTokens).toBe(42);
    expect(metadata?.subagentCost).toBe(0);
  });

  it('leaves other metadata fields untouched', () => {
    useCliStore.setState({ session: makeSession({ totalTokens: 999, toolCallCount: 7 }) });

    useCliStore.getState().recordSubagentUsage({ tokens: 10 });

    const metadata = useCliStore.getState().session?.metadata;
    expect(metadata?.totalTokens).toBe(999);
    expect(metadata?.toolCallCount).toBe(7);
  });
});

describe('resolvePermissionPromptById', () => {
  function makePrompt(id: string) {
    const resolve = vi.fn<(r: { action: PermissionResponse }) => void>();
    return {
      state: { id, toolName: 'Bash', args: { cmd: 'ls' }, canBeTrusted: true, resolve },
      resolve,
    };
  }

  beforeEach(() => {
    useCliStore.setState({ permissionPrompt: null, permissionQueue: [] });
  });

  it('resolves the active prompt and dequeues to the next queued prompt', () => {
    const a = makePrompt('perm-1');
    const b = makePrompt('perm-2');
    useCliStore.getState().enqueuePermissionPrompt(a.state);
    useCliStore.getState().enqueuePermissionPrompt(b.state);

    const ok = useCliStore.getState().resolvePermissionPromptById('perm-1', 'allow-once');

    expect(ok).toBe(true);
    expect(a.resolve).toHaveBeenCalledWith({ action: 'allow-once' });
    expect(useCliStore.getState().permissionPrompt?.id).toBe('perm-2');
    expect(useCliStore.getState().permissionQueue).toHaveLength(0);
  });

  it('resolves a queued (non-active) prompt without disturbing the active one', () => {
    const a = makePrompt('perm-1');
    const b = makePrompt('perm-2');
    const c = makePrompt('perm-3');
    useCliStore.getState().enqueuePermissionPrompt(a.state);
    useCliStore.getState().enqueuePermissionPrompt(b.state);
    useCliStore.getState().enqueuePermissionPrompt(c.state);

    const ok = useCliStore.getState().resolvePermissionPromptById('perm-2', 'deny');

    expect(ok).toBe(true);
    expect(b.resolve).toHaveBeenCalledWith({ action: 'deny' });
    expect(a.resolve).not.toHaveBeenCalled();
    expect(c.resolve).not.toHaveBeenCalled();
    expect(useCliStore.getState().permissionPrompt?.id).toBe('perm-1');
    expect(useCliStore.getState().permissionQueue.map(p => p.id)).toEqual(['perm-3']);
  });

  it('returns false for an unknown id and does not mutate state', () => {
    const a = makePrompt('perm-1');
    useCliStore.getState().enqueuePermissionPrompt(a.state);

    const ok = useCliStore.getState().resolvePermissionPromptById('perm-999', 'deny');

    expect(ok).toBe(false);
    expect(a.resolve).not.toHaveBeenCalled();
    expect(useCliStore.getState().permissionPrompt?.id).toBe('perm-1');
  });

  it('returns false on the second call (loser of a tavern/Ink race no-ops)', () => {
    const a = makePrompt('perm-1');
    useCliStore.getState().enqueuePermissionPrompt(a.state);

    const first = useCliStore.getState().resolvePermissionPromptById('perm-1', 'allow-once');
    const second = useCliStore.getState().resolvePermissionPromptById('perm-1', 'deny');

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(a.resolve).toHaveBeenCalledTimes(1);
    expect(a.resolve).toHaveBeenCalledWith({ action: 'allow-once' });
  });

  it('does not mutate the previous queue array reference (immutability check)', () => {
    const a = makePrompt('perm-1');
    const b = makePrompt('perm-2');
    const c = makePrompt('perm-3');
    useCliStore.getState().enqueuePermissionPrompt(a.state);
    useCliStore.getState().enqueuePermissionPrompt(b.state);
    useCliStore.getState().enqueuePermissionPrompt(c.state);

    const queueBefore = useCliStore.getState().permissionQueue;
    useCliStore.getState().resolvePermissionPromptById('perm-2', 'allow-once');
    const queueAfter = useCliStore.getState().permissionQueue;

    // Original snapshot is unchanged (no in-place splice on the captured ref).
    expect(queueBefore.map(p => p.id)).toEqual(['perm-2', 'perm-3']);
    // New queue is a fresh array with perm-2 removed.
    expect(queueAfter).not.toBe(queueBefore);
    expect(queueAfter.map(p => p.id)).toEqual(['perm-3']);
  });
});

describe('background shell sessions', () => {
  const makeShell = (id: string, status: ShellSessionStatus, exitCode: number | null = null): ShellSession => ({
    id,
    command: `sleep ${id}`,
    cwd: '/tmp',
    status,
    exitCode,
    startTime: 0,
    totalOutputChars: 0,
  });

  beforeEach(() => {
    useCliStore.setState({ backgroundShells: [] });
  });

  it('adds a new session on first upsert', () => {
    useCliStore.getState().upsertBackgroundShell(makeShell('a', 'running'));
    expect(useCliStore.getState().backgroundShells).toHaveLength(1);
  });

  it('updates an existing session in place (by id) instead of duplicating', () => {
    const { upsertBackgroundShell } = useCliStore.getState();
    upsertBackgroundShell(makeShell('a', 'running'));
    upsertBackgroundShell(makeShell('a', 'exited', 0));

    const shells = useCliStore.getState().backgroundShells;
    expect(shells).toHaveLength(1);
    expect(shells[0].status).toBe('exited');
    expect(shells[0].exitCode).toBe(0);
  });

  it('selects only running sessions as active', () => {
    const { upsertBackgroundShell } = useCliStore.getState();
    upsertBackgroundShell(makeShell('a', 'running'));
    upsertBackgroundShell(makeShell('b', 'exited', 0));
    upsertBackgroundShell(makeShell('c', 'killed'));

    const active = selectActiveBackgroundShells(useCliStore.getState());
    const completed = selectCompletedBackgroundShells(useCliStore.getState());
    expect(active.map(s => s.id)).toEqual(['a']);
    expect(completed.map(s => s.id)).toEqual(['b', 'c']);
  });

  it('cleanup removes terminal sessions but keeps running ones', () => {
    const { upsertBackgroundShell, cleanupCompletedBackgroundShells } = useCliStore.getState();
    upsertBackgroundShell(makeShell('a', 'running'));
    upsertBackgroundShell(makeShell('b', 'exited', 0));
    upsertBackgroundShell(makeShell('c', 'timed_out'));

    cleanupCompletedBackgroundShells();
    expect(useCliStore.getState().backgroundShells.map(s => s.id)).toEqual(['a']);
  });

  it('returns stable empty references when there is nothing to select', () => {
    const active = selectActiveBackgroundShells(useCliStore.getState());
    expect(active).toEqual([]);
    // Same reference across calls so useShallow does not re-render.
    expect(selectActiveBackgroundShells(useCliStore.getState())).toBe(active);
  });
});
