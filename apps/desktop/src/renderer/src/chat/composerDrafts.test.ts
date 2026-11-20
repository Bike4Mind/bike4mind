import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDrafts } from '@shared/composerDrafts';
import { createComposerDraftsStore } from './composerDrafts';

function bridge(saved: ComposerDrafts = {}) {
  return {
    list: vi.fn(async () => saved),
    save: vi.fn(async (_sessionId: string, _text: string) => undefined),
  };
}

describe('createComposerDraftsStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restores saved drafts on hydrate', async () => {
    const api = bridge({ s1: 'from last launch' });
    const drafts = createComposerDraftsStore(() => api);
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'from last launch' }, hydrated: true });
  });

  it('keeps text typed before hydrate over the saved copy', async () => {
    const api = bridge({ s1: 'old', s2: 'cleared since' });
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'new');
    drafts.update('s2', 'x');
    drafts.update('s2', '');
    await drafts.hydrate();
    expect(drafts.state.getState().drafts).toEqual({ s1: 'new' });
  });

  it('debounces saves while typing and writes only the last text', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api, 500);
    drafts.update('s1', 'h');
    drafts.update('s1', 'he');
    vi.advanceTimersByTime(400);
    drafts.update('s1', 'hey');
    vi.advanceTimersByTime(499);
    expect(api.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(api.save.mock.calls).toEqual([['s1', 'hey']]);
  });

  it('flushes a pending save at once, for blur, switch and unload', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api, 500);
    drafts.update('s1', 'one');
    drafts.update('s2', 'two');
    drafts.flush('s1');
    expect(api.save.mock.calls).toEqual([['s1', 'one']]);
    drafts.flush();
    expect(api.save.mock.calls).toEqual([
      ['s1', 'one'],
      ['s2', 'two'],
    ]);
    // Nothing left waiting: the timers do not save again.
    vi.runAllTimers();
    expect(api.save).toHaveBeenCalledTimes(2);
  });

  it('clears immediately when the composer is emptied or sent, cancelling a pending save', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api, 500);
    drafts.update('s1', 'about to send');
    drafts.update('s1', '');
    expect(api.save.mock.calls).toEqual([['s1', '']]);
    expect(drafts.state.getState().drafts).toEqual({});
    vi.runAllTimers();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it('treats blank text as no draft and does not save an unchanged one', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api, 500);
    drafts.update('s1', '   ');
    drafts.update('s1', '');
    expect(api.save).not.toHaveBeenCalled();
    expect(drafts.state.getState().drafts).toEqual({});
  });

  it('keeps drafts in memory when there is no bridge', async () => {
    const drafts = createComposerDraftsStore(() => undefined, 500);
    drafts.update('s1', 'only here');
    vi.runAllTimers();
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'only here' }, hydrated: true });
  });
});
