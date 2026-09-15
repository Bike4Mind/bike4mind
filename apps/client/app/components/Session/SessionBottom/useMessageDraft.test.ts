import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useMessageDraft } from './useMessageDraft';
import { NEW_NOTEBOOK_DRAFT_KEY } from '@client/app/hooks/useChatInput';

// useMessageDraft reads the live input via useChatInput.getState().chatInputValue.
const h = vi.hoisted(() => ({ chatInputValue: '' }));
vi.mock('@client/app/hooks/useChatInput', async importActual => {
  const actual = await importActual<typeof import('@client/app/hooks/useChatInput')>();
  return {
    ...actual,
    useChatInput: { getState: () => ({ chatInputValue: h.chatInputValue }) },
  };
});

function setup(drafts: Record<string, string> = {}) {
  const store = { ...drafts };
  const setChatInputValue = vi.fn((v: string) => {
    h.chatInputValue = v;
  });
  const setDraft = vi.fn((id: string, v: string) => {
    store[id] = v;
  });
  const getDraft = vi.fn((id: string) => store[id] ?? '');
  const clearDraft = vi.fn((id: string) => {
    delete store[id];
  });
  return { store, setChatInputValue, setDraft, getDraft, clearDraft };
}

describe('useMessageDraft', () => {
  beforeEach(() => {
    h.chatInputValue = '';
  });

  it('restores a saved draft for the session on first mount', () => {
    const { setChatInputValue, setDraft, getDraft, clearDraft } = setup({ s1: 'hello' });
    renderHook(() => useMessageDraft('s1', setChatInputValue, setDraft, getDraft, clearDraft));
    expect(setChatInputValue).toHaveBeenCalledWith('hello');
  });

  it('does not clobber the input on first mount when there is no saved draft', () => {
    const { setChatInputValue, setDraft, getDraft, clearDraft } = setup();
    renderHook(() => useMessageDraft('s1', setChatInputValue, setDraft, getDraft, clearDraft));
    expect(setChatInputValue).not.toHaveBeenCalled();
  });

  it('restores the new-notebook draft on first mount when there is no session id', () => {
    const { setChatInputValue, setDraft, getDraft, clearDraft } = setup({
      [NEW_NOTEBOOK_DRAFT_KEY]: 'unsent text',
    });
    renderHook(() => useMessageDraft(null, setChatInputValue, setDraft, getDraft, clearDraft));
    expect(setChatInputValue).toHaveBeenCalledWith('unsent text');
  });

  it('saves the outgoing draft and restores the incoming one on a session switch', () => {
    const { store, setChatInputValue, setDraft, getDraft, clearDraft } = setup({ s2: 'draft two' });
    h.chatInputValue = 'draft one';
    const { rerender } = renderHook(
      ({ id }) => useMessageDraft(id, setChatInputValue, setDraft, getDraft, clearDraft),
      { initialProps: { id: 's1' as string | null } }
    );
    rerender({ id: 's2' });
    expect(store.s1).toBe('draft one');
    expect(setChatInputValue).toHaveBeenLastCalledWith('draft two');
  });

  it('drops the new-notebook draft and restores the target when a null session resolves to an id', () => {
    const { store, setChatInputValue, setDraft, getDraft, clearDraft } = setup({
      [NEW_NOTEBOOK_DRAFT_KEY]: 'stale',
    });
    const { rerender } = renderHook(
      ({ id }) => useMessageDraft(id, setChatInputValue, setDraft, getDraft, clearDraft),
      { initialProps: { id: null as string | null } }
    );
    rerender({ id: 's9' });
    expect(store[NEW_NOTEBOOK_DRAFT_KEY]).toBeUndefined();
    expect(setChatInputValue).toHaveBeenLastCalledWith('');
  });
});
