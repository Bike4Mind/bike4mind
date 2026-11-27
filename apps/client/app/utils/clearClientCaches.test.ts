import { describe, it, expect, beforeEach, vi } from 'vitest';

// The generated glue is empty in the open-core tree, so the sweep has nothing to do
// unless a contribution is stubbed in - mock it to stand in for an installed overlay.
// The array identity is stable, so each test mutates it in place via setPrefixes().
const { premiumLocalStorageKeyPrefixes } = vi.hoisted(() => ({
  premiumLocalStorageKeyPrefixes: [] as string[],
}));
vi.mock('../premium-generated/premiumLocalStorageKeys.generated', () => ({
  premiumLocalStorageKeyPrefixes,
}));

vi.mock('idb-keyval', () => ({ del: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./dexie', () => ({ dexie: { delete: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./tagCache', () => ({ tagCacheManager: { clearAllCaches: vi.fn().mockResolvedValue(undefined) } }));

import { FIRST_SIGNUP_SESSION_KEY } from './firstSignupSession';
import { MFA_ENROLLMENT_HINT_KEY } from './mfaEnrollmentHint';
import { clearClientCaches } from './clearClientCaches';
import { useChatInput } from '../hooks/useChatInput';
import { getStoredJupyterConfig, subscribeStoredJupyterConfig } from './jupyterBrowserClient';

function setPrefixes(prefixes: string[]) {
  premiumLocalStorageKeyPrefixes.length = 0;
  premiumLocalStorageKeyPrefixes.push(...prefixes);
}

beforeEach(() => {
  localStorage.clear();
  setPrefixes([]);
});

describe('clearClientCaches premium localStorage sweep', () => {
  it('removes every key under a declared prefix, including per-identity variants', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('overlay-panel:', 'legacy-global');
    localStorage.setItem('overlay-panel:user-a', 'a');
    localStorage.setItem('overlay-panel:user-b', 'b');

    await clearClientCaches();

    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('leaves keys no overlay declared alone', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('overlay-panel:user-a', 'a');
    localStorage.setItem('unrelated-app-setting', 'keep me');
    // Near-miss: the prefix must match at the START of the key, not anywhere in it.
    localStorage.setItem('not-an-overlay-panel:user-a', 'keep me too');

    await clearClientCaches();

    expect(Object.keys(localStorage).sort()).toEqual(['not-an-overlay-panel:user-a', 'unrelated-app-setting']);
  });

  it('is a no-op for the open-core tree, where no overlay declares a prefix', async () => {
    localStorage.setItem('some-other-key', 'value');

    await clearClientCaches();

    expect(localStorage.getItem('some-other-key')).toBe('value');
  });

  it('still clears the core allowlist alongside the sweep', async () => {
    setPrefixes(['overlay-panel:']);
    localStorage.setItem('user-context', 'stale');
    localStorage.setItem('artifacts', 'stale');
    localStorage.setItem('overlay-panel:user-a', 'stale');

    await clearClientCaches();

    expect(Object.keys(localStorage)).toEqual([]);
  });
});

describe('clearClientCaches identity-scoped stores', () => {
  it('ends first-session modal suppression on identity teardown', async () => {
    localStorage.setItem(FIRST_SIGNUP_SESSION_KEY, 'new-user');
    await clearClientCaches();
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });

  it('drops the persisted model pick so the next account starts from its own default', async () => {
    localStorage.setItem('llm-settings', JSON.stringify({ state: { model: 'some-model' }, version: 6 }));

    await clearClientCaches();

    expect(localStorage.getItem('llm-settings')).toBeNull();
  });

  it('drops the MFA enrollment hint so the next account is checked from scratch', async () => {
    localStorage.setItem(MFA_ENROLLMENT_HINT_KEY, JSON.stringify({ userId: 'u1', enrolled: true }));

    await clearClientCaches();

    expect(localStorage.getItem(MFA_ENROLLMENT_HINT_KEY)).toBeNull();
  });

  it('drops unsent chat drafts from storage and from the live store', async () => {
    useChatInput.getState().setDraft('__new_notebook__', 'half-typed prompt');
    expect(localStorage.getItem('chat-input-drafts')).not.toBeNull();

    await clearClientCaches();

    expect(localStorage.getItem('chat-input-drafts')).toBeNull();
    expect(useChatInput.getState().getDraft('__new_notebook__')).toBe('');
  });

  it('drops the saved Jupyter server and token', async () => {
    localStorage.setItem('b4m-jupyter-config', JSON.stringify({ serverUrl: 'http://jupyter.test', token: 't' }));
    const onChange = vi.fn();
    const unsubscribe = subscribeStoredJupyterConfig(onChange);

    await clearClientCaches();
    unsubscribe();

    expect(localStorage.getItem('b4m-jupyter-config')).toBeNull();
    expect(getStoredJupyterConfig()).toBeNull();
    expect(onChange).toHaveBeenCalled();
  });

  it('deletes service worker runtime caches but keeps the precache', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['serwist-precache-v2-https://app.example.com/', 'others', 'cross-origin']),
      delete: vi.fn(async (name: string) => {
        deleted.push(name);
        return true;
      }),
    });
    try {
      await clearClientCaches();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(deleted.sort()).toEqual(['cross-origin', 'others']);
  });
});
