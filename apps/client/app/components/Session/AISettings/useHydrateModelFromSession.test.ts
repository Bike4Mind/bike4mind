import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ISessionDocument } from '@bike4mind/common';
import { useHydrateModelFromSession } from './useHydrateModelFromSession';

type SessionArg = Pick<ISessionDocument, 'id' | 'lastUsedModel'> | null;

const session = (id: string, lastUsedModel: string | null): SessionArg => ({ id, lastUsedModel }) as SessionArg;

/** Renders the hook with a stable applyModel spy, mirroring the component's useCallback. */
function setup(initial: SessionArg) {
  const applyModel = vi.fn();
  const view = renderHook(({ s }: { s: SessionArg }) => useHydrateModelFromSession(s, applyModel), {
    initialProps: { s: initial },
  });
  return { applyModel, view };
}

describe('useHydrateModelFromSession', () => {
  it('adopts the session pinned model on first load', () => {
    const { applyModel } = setup(session('sess-1', 'grok-3'));
    expect(applyModel).toHaveBeenCalledExactlyOnceWith('grok-3');
  });

  /**
   * The actual production bug. SessionsContext bumps lastUpdated/updatedAt in the send path,
   * producing a NEW session object that still carries the OLD lastUsedModel. The old effect
   * re-fired on that identity change and clobbered the user's pick, so the turn ran on the
   * previous model. Observed live: Claude 5 Sonnet selected twice, zero Sonnet requests billed.
   */
  it('does NOT re-apply when the session object identity changes but the id does not', () => {
    const { applyModel, view } = setup(session('sess-1', 'grok-3'));
    applyModel.mockClear();

    // User picks a different model in the picker (local LLM state, not yet persisted),
    // then sends -- which bumps the timestamp and hands us a fresh object carrying the
    // stale lastUsedModel.
    view.rerender({ s: { id: 'sess-1', lastUsedModel: 'grok-3' } as SessionArg });
    view.rerender({ s: { id: 'sess-1', lastUsedModel: 'grok-3' } as SessionArg });

    expect(applyModel).not.toHaveBeenCalled();
  });

  it('does not re-apply even if the server later reports a different pinned model', () => {
    // The server writes lastUsedModel from the model that actually ran, which is what made
    // the old revert self-reinforcing. A mid-session change must not seize the picker.
    const { applyModel, view } = setup(session('sess-1', 'grok-3'));
    applyModel.mockClear();

    view.rerender({ s: session('sess-1', 'claude-opus-5') });

    expect(applyModel).not.toHaveBeenCalled();
  });

  it('hydrates again when the user switches to a different session', () => {
    const { applyModel, view } = setup(session('sess-1', 'grok-3'));
    applyModel.mockClear();

    view.rerender({ s: session('sess-2', 'claude-opus-5') });

    expect(applyModel).toHaveBeenCalledExactlyOnceWith('claude-opus-5');
  });

  it('re-hydrates a session revisited after being cleared', () => {
    const { applyModel, view } = setup(session('sess-1', 'grok-3'));
    applyModel.mockClear();

    view.rerender({ s: null }); // notebook closed
    view.rerender({ s: session('sess-1', 'grok-3') }); // reopened

    expect(applyModel).toHaveBeenCalledExactlyOnceWith('grok-3');
  });

  it('stays eligible when the session arrives before its pinned model', () => {
    // Guards the ref bookkeeping: recording a session as hydrated before a model was
    // actually applied would strand the picker on whatever it defaulted to.
    const { applyModel, view } = setup(session('sess-1', null));
    expect(applyModel).not.toHaveBeenCalled();

    view.rerender({ s: session('sess-1', 'claude-opus-5') });

    expect(applyModel).toHaveBeenCalledExactlyOnceWith('claude-opus-5');
  });

  it('does nothing when there is no session', () => {
    const { applyModel } = setup(null);
    expect(applyModel).not.toHaveBeenCalled();
  });
});
