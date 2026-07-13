import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useCliStore,
  selectActiveBackgroundShells,
  selectCompletedBackgroundShells,
  selectLiveSubagentTokens,
  selectLiveSubagentCredits,
} from './index.js';
import type { PermissionResponse } from '../components';
import type { ShellSession, ShellSessionStatus } from '@bike4mind/services/llm/tools/cliTools';

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

describe('subagent usage tracking', () => {
  const makeSession = () => ({
    id: 's1',
    name: 'test',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    model: 'test-model',
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
  });

  beforeEach(() => {
    useCliStore.setState({ session: makeSession(), liveSubagentUsage: {} });
  });

  it('tracks live usage per run id and removes entries on completion', () => {
    const { updateLiveSubagentUsage } = useCliStore.getState();
    updateLiveSubagentUsage('run-1', 'explore', 100, 1);
    updateLiveSubagentUsage('run-2', 'explore', 200, 2);
    updateLiveSubagentUsage('run-1', 'explore', 150, 1);

    expect(useCliStore.getState().liveSubagentUsage).toEqual({
      'run-1': { agentName: 'explore', tokens: 150, credits: 1 },
      'run-2': { agentName: 'explore', tokens: 200, credits: 2 },
    });

    useCliStore.getState().removeLiveSubagentUsage('run-1');
    expect(useCliStore.getState().liveSubagentUsage).toEqual({
      'run-2': { agentName: 'explore', tokens: 200, credits: 2 },
    });
  });

  it('sums live usage across running agents via selectors', () => {
    const { updateLiveSubagentUsage } = useCliStore.getState();
    updateLiveSubagentUsage('run-1', 'explore', 100, 1);
    updateLiveSubagentUsage('run-2', 'plan', 250, 3);

    expect(selectLiveSubagentTokens(useCliStore.getState())).toBe(350);
    expect(selectLiveSubagentCredits(useCliStore.getState())).toBe(4);
  });

  it('folds completions into session metadata rollups and per-agent breakdown', () => {
    const { recordSubagentCompletion } = useCliStore.getState();
    recordSubagentCompletion('explore', 1000, 5);
    recordSubagentCompletion('explore', 500, 2);
    recordSubagentCompletion('plan', 300, 1);

    const metadata = useCliStore.getState().session!.metadata;
    expect(metadata.subagentCalls).toBe(3);
    expect(metadata.subagentTokens).toBe(1800);
    expect(metadata.subagentCost).toBe(8);
    expect(metadata.subagentUsage).toEqual({
      explore: { calls: 2, tokens: 1500, credits: 7 },
      plan: { calls: 1, tokens: 300, credits: 1 },
    });
  });

  it('recordSubagentCompletion is a no-op without a session', () => {
    useCliStore.setState({ session: null });
    useCliStore.getState().recordSubagentCompletion('explore', 100, 1);
    expect(useCliStore.getState().session).toBeNull();
  });
});
