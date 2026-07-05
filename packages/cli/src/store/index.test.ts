import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCliStore } from './index.js';
import type { PermissionResponse } from '../components';

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
