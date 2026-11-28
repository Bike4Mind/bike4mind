import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ del: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/dexie', () => ({ dexie: { delete: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../utils/tagCache', () => ({ tagCacheManager: { clearAllCaches: vi.fn().mockResolvedValue(undefined) } }));

import { useChatInput, NEW_NOTEBOOK_DRAFT_KEY } from './useChatInput';
import { resetSignedInUserIdForTests, setSignedInUserId } from '../utils/identityScopedStorage';
import { clearClientCaches } from '../utils/clearClientCaches';

function persistedDrafts() {
  return JSON.parse(localStorage.getItem('chat-input-drafts') ?? 'null')?.state;
}

beforeEach(() => {
  localStorage.clear();
  resetSignedInUserIdForTests();
  useChatInput.setState({ drafts: {}, draftsOwnerId: null, chatInputValue: '' });
});

describe('useChatInput draft ownership', () => {
  it('records the signed-in user as the owner of a saved draft', () => {
    setSignedInUserId('user-a');
    useChatInput.getState().setDraft('s1', 'hello');

    expect(persistedDrafts()).toEqual({ drafts: { s1: 'hello' }, draftsOwnerId: 'user-a' });
  });

  it('gives the same user their drafts back after an expired session', async () => {
    setSignedInUserId('user-a');
    useChatInput.getState().setDraft(NEW_NOTEBOOK_DRAFT_KEY, 'unsent');

    await clearClientCaches({ sessionExpired: true });
    resetSignedInUserIdForTests();
    setSignedInUserId('user-a');

    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('unsent');
  });

  it('drops the drafts when a different user signs in after an expired session', async () => {
    setSignedInUserId('user-a');
    useChatInput.getState().setDraft(NEW_NOTEBOOK_DRAFT_KEY, 'unsent');

    await clearClientCaches({ sessionExpired: true });
    setSignedInUserId('user-b');

    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('');
    expect(persistedDrafts()).toEqual({ drafts: {}, draftsOwnerId: 'user-b' });
  });

  it('wipes the drafts on an explicit sign-out even for the same user', async () => {
    setSignedInUserId('user-a');
    useChatInput.getState().setDraft(NEW_NOTEBOOK_DRAFT_KEY, 'unsent');

    await clearClientCaches();
    resetSignedInUserIdForTests();
    setSignedInUserId('user-a');

    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('');
  });

  it('drops drafts saved without an owner once someone signs in', () => {
    useChatInput.setState({ drafts: { [NEW_NOTEBOOK_DRAFT_KEY]: 'legacy' }, draftsOwnerId: null });

    setSignedInUserId('user-a');

    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('');
    expect(useChatInput.getState().drafts).toEqual({});
  });

  it('does not restore the new-notebook draft for anyone but its owner', () => {
    setSignedInUserId('user-b');
    useChatInput.setState({ drafts: { [NEW_NOTEBOOK_DRAFT_KEY]: 'theirs' }, draftsOwnerId: 'user-a' });

    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('');
  });
});
