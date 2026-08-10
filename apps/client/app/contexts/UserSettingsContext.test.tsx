import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserSettingsProvider, useUserSettings } from './UserSettingsContext';

type MockUser = { id: string; preferences: Record<string, unknown> } & Record<string, unknown>;

const defaultUser = (): MockUser => ({ id: 'u1', preferences: { experimentalFeatures: {} } });

// Real zustand stores rather than plain stubs: the write-failure rollback is only observable
// if a store write actually re-renders the provider, which is what drives `settings` and
// `rawExperimentalPreferences` back to the pre-write values.
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const useUser = create<{
    currentUser: MockUser | null;
    isHydrated: boolean;
    setCurrentUser: (user: MockUser) => void;
  }>(set => ({
    currentUser: { id: 'u1', preferences: { experimentalFeatures: {} } },
    isHydrated: true,
    setCurrentUser: user => set({ currentUser: user }),
  }));
  return { useUser };
});

vi.mock('@client/app/contexts/TranslationProvider', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const useLanguage = create<{ language: string; setLanguage: (language: string) => void }>(set => ({
    language: 'en',
    setLanguage: language => set({ language }),
  }));
  return { useLanguage };
});

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mockToastError } }));

const { mockServerSettings } = vi.hoisted(() => ({ mockServerSettings: { data: undefined as unknown } }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => mockServerSettings,
}));

vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: vi.fn(),
}));

vi.mock('@client/app/utils/userAPICalls', () => ({
  updateUserToServer: vi.fn().mockResolvedValue({}),
}));

const { useUser } = await import('@client/app/contexts/UserContext');
const { useLanguage } = await import('@client/app/contexts/TranslationProvider');
const { updateUserToServer } = await import('@client/app/utils/userAPICalls');

const storedUser = () => useUser.getState().currentUser as MockUser;
const storedPrefs = () => storedUser().preferences as Record<string, unknown>;
const storedFeatures = () => storedPrefs().experimentalFeatures as Record<string, boolean>;

/**
 * An axios-shaped rejection. Deliberately a plain object rather than a real `AxiosError`:
 * axios resolves both predicates by property, not prototype - `isAxiosError` is
 * `isObject(payload) && payload.isAxiosError === true`, and `isCancel` is `!!value.__CANCEL__`.
 * If a future axios tightened either to a prototype check, these helpers would need real
 * instances instead.
 */
function axiosError(status: number, data?: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

function cancelError() {
  return Object.assign(new Error('canceled'), { __CANCEL__: true });
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <UserSettingsProvider>{children}</UserSettingsProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

function resetStores() {
  useUser.setState({ currentUser: defaultUser(), isHydrated: true });
  useLanguage.setState({ language: 'en' });
  mockServerSettings.data = undefined;
  vi.mocked(updateUserToServer).mockReset().mockResolvedValue({});
}

describe('UserSettingsContext - rawExperimentalPreferences optimistic update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('reflects the toggled value in rawExperimentalPreferences immediately, without waiting for a server echo', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    expect(result.current.rawExperimentalPreferences.enableAgents).toBeUndefined();

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });

    expect(result.current.rawExperimentalPreferences.enableAgents).toBe(true);
  });

  it('toggles false immediately in rawExperimentalPreferences when set to false', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });
    expect(result.current.rawExperimentalPreferences.enableAgents).toBe(true);

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: false } });
    });
    expect(result.current.rawExperimentalPreferences.enableAgents).toBe(false);
  });

  it('only updates the toggled key without clobbering other keys in rawExperimentalPreferences', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableArtifacts: true } });
    });
    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });

    expect(result.current.rawExperimentalPreferences.enableArtifacts).toBe(true);
    expect(result.current.rawExperimentalPreferences.enableAgents).toBe(true);
  });

  // guards the store write-through in updatePreferences (delete that line -> this fails).
  it('writes the toggled preference through to the useUser store', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });

    expect(storedFeatures().enableAgents).toBe(true);
  });
});

describe('UserSettingsContext - scalar preference round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('defaults showSplashCards to false when the server has no value', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.settings.showSplashCards).toBe(false);
  });

  // A scalar pref only survives a reload if it is in SCALAR_PREF_KEYS *and* both
  // server-side allowlists (the Zod updateUserSchema and the Mongoose
  // UserPreferencesSchema). This covers the client half: drop the key from
  // SCALAR_PREF_KEYS and the optimistic read below reverts to the default.
  it('applies showSplashCards optimistically and persists it to the server', () => {
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(result.current.settings.showSplashCards).toBe(true);
    expect(updateUserToServer).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ preferences: expect.objectContaining({ showSplashCards: true }) })
    );
    expect(storedPrefs().showSplashCards).toBe(true);
  });

  // The preferences effect rebuilds settings wholesale from mergeServerPreferences, which
  // knows nothing about admin settings - so it has to carry them over or a preference change
  // blanks every server-settings consumer until the admin effect happens to run again.
  it('keeps admin serverSettings when a preference changes', () => {
    mockServerSettings.data = [{ settingName: 'foo', settingValue: 'bar' }];
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.settings.serverSettings).toHaveLength(1);

    act(() => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(result.current.settings.serverSettings).toHaveLength(1);
  });

  it('merges a server-provided showSplashCards over the default', () => {
    useUser.setState({ currentUser: { id: 'u1', preferences: { experimentalFeatures: {}, showSplashCards: true } } });
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.settings.showSplashCards).toBe(true);
  });
});

// Pins the failure/race boundary the user-feedback work rests on: a lost concurrent
// toggle and a failed write are DIFFERENT events, and only the latter reaches the
// rejection path. Without this, a future reader could reasonably assume adding user
// feedback to the write path would also fire on the benign race.
describe('UserSettingsContext - concurrent toggles vs. a failed write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('does not reach the write-failure path when a concurrent toggle loses the race', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The server accepts BOTH racing writes - the loser is overwritten, not rejected.
    vi.mocked(updateUserToServer).mockResolvedValue({});

    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    // Same tick, so neither call sees the other's store write: this is the race.
    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
      result.current.updatePreferences({ experimentalFeatures: { enableArtifacts: true } });
    });

    expect(updateUserToServer).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('silently drops the losing toggle from the persisted payload', async () => {
    vi.mocked(updateUserToServer).mockResolvedValue({});

    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
      result.current.updatePreferences({ experimentalFeatures: { enableArtifacts: true } });
    });

    // Both calls built their payload from the same stale base, so the second write
    // carries only its own key - enableAgents never reaches the server.
    const secondPayload = vi.mocked(updateUserToServer).mock.calls[1][1] as {
      preferences: { experimentalFeatures: Record<string, boolean> };
    };
    expect(secondPayload.preferences.experimentalFeatures.enableArtifacts).toBe(true);
    expect(secondPayload.preferences.experimentalFeatures.enableAgents).toBeUndefined();
  });

  it('reaches the write-failure path when the server genuinely rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(422));

    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });

    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

describe('UserSettingsContext - preferences write failure feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('toasts once when the write fails', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0][0]).toMatch(/could not save/i);
  });

  // The 422 that made #1126's telemetry control look dead: the server says which value it
  // rejected, so that message is worth more to the user than a generic line.
  it('surfaces the server error message when the response carries one', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(
      axiosError(422, { error: 'Invalid contextTelemetryLevel: expected none | basic | enhanced' })
    );
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ contextTelemetryLevel: 'enhanced' });
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Invalid contextTelemetryLevel: expected none | basic | enhanced',
      expect.anything()
    );
  });

  // The 5xx catch-all in server/middlewares/errorHandler.ts sets `error` from the thrown
  // exception, so on an unmapped 500 that field names hosts, collections or indexes. Without the
  // status gate this would be toasted verbatim - internal-detail disclosure, and unactionable.
  it('does not surface the server error string on a 5xx', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(
      axiosError(500, { error: 'E11000 duplicate key error collection: b4m-stage.users index: email_1' })
    );
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError.mock.calls[0][0]).toMatch(/could not save/i);
    expect(mockToastError.mock.calls[0][0]).not.toMatch(/E11000|b4m-stage/);
  });

  it('does not surface a bare Forbidden from a 403', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(403, { error: 'Forbidden' }));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError.mock.calls[0][0]).toMatch(/could not save/i);
  });

  it('falls back to a generic message when the server error is not a usable string', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500, { error: { code: 'E_INTERNAL' } }));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError.mock.calls[0][0]).toMatch(/could not save/i);
  });

  // The api interceptor already refreshes then redirects on 401; a toast would stack noise
  // on top of a session teardown the user cannot act on.
  it('stays quiet on a mid-MFA 401', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(401, { mfaPending: true }));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError).not.toHaveBeenCalled();
  });

  // The interceptor's two non-redirecting 401 exits leave the user on a working page with the
  // change lost. `_retryCount` cannot distinguish them - it is only incremented AFTER a
  // successful refresh (ApiContext.tsx:206 and :265), so a transient refresh-endpoint failure
  // (the deploy-window case) arrives with a count of 0 and must still toast.
  it('toasts a 401 the interceptor could not recover from, including a transient refresh failure', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(401));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on a cancelled request', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(cancelError());
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('reuses one toast id so a burst of failures cannot stack toasts', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });
    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableArtifacts: true } });
    });

    expect(mockToastError).toHaveBeenCalledTimes(2);
    const ids = mockToastError.mock.calls.map(call => (call[1] as { id?: string }).id);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('UserSettingsContext - preferences write failure rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // The actual #1256 symptom: without this the optimistic value stays on screen and only
  // reverts on the next reload, so the control looks like it worked.
  it('reverts the optimistic value in the store and in settings when the write fails', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(storedPrefs().showSplashCards).toBeUndefined();
    expect(result.current.settings.showSplashCards).toBe(false);
  });

  it('reverts an experimental feature toggle in rawExperimentalPreferences when the write fails', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });

    expect(storedFeatures().enableAgents).toBeUndefined();
    expect(result.current.rawExperimentalPreferences.enableAgents).toBeUndefined();
  });

  // `UserModel` defaults `preferences` to null, so this is the state of every user who has
  // never saved one - and the likeliest population to have a first write rejected. The
  // rollback restores the store to null either way; what this pins is that the derived
  // `settings` follow it instead of stranding the optimistic value on screen.
  it('reverts the on-screen value for a user whose preferences are null', async () => {
    useUser.setState({ currentUser: { id: 'u1', preferences: null } as unknown as MockUser });
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      result.current.updatePreferences({ showSplashCards: true });
    });

    expect(result.current.settings.showSplashCards).toBe(false);
  });

  it('preserves unrelated user fields written while the failing request was in flight', async () => {
    let rejectWrite: ((error: unknown) => void) | undefined;
    vi.mocked(updateUserToServer).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        })
    );
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ showSplashCards: true });
    });
    // A websocket push lands mid-flight, keeping our preferences object but moving another field.
    act(() => {
      useUser.setState({ currentUser: { ...storedUser(), currentCredits: 42 } });
    });

    await act(async () => {
      rejectWrite?.(axiosError(500));
    });

    expect(storedPrefs().showSplashCards).toBeUndefined();
    expect(storedUser().currentCredits).toBe(42);
  });

  // The guard the issue's caution is really about: rollback is the only part of this that can
  // interact with concurrency, and a stale snapshot must never undo a newer write.
  it('does not roll back over a newer write that landed first', async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    vi.mocked(updateUserToServer)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce({});

    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    act(() => {
      result.current.updatePreferences({ experimentalFeatures: { enableAgents: true } });
    });
    await act(async () => {
      result.current.updatePreferences({ experimentalFeatures: { enableArtifacts: true } });
    });

    await act(async () => {
      rejectFirst?.(axiosError(500));
    });

    // The second write succeeded and owns the store now; the first write's rollback must
    // leave it alone rather than reinstating its own pre-write snapshot.
    expect(storedFeatures().enableArtifacts).toBe(true);
    expect(result.current.rawExperimentalPreferences.enableArtifacts).toBe(true);
  });
});

describe('UserSettingsContext - language write failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('toasts and restores the previous language when the write fails', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      useLanguage.getState().setLanguage('fr');
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0][0]).toMatch(/language/i);
    expect(useLanguage.getState().language).toBe('en');
  });

  // Restoring the language must not look like a fresh user edit, or the rollback writes
  // itself back to the server (and can fail, and toast, forever).
  it('does not write the restored language back to the server', async () => {
    vi.mocked(updateUserToServer).mockRejectedValue(axiosError(500));
    renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      useLanguage.getState().setLanguage('fr');
    });

    expect(updateUserToServer).toHaveBeenCalledTimes(1);
  });

  it('leaves a newer language choice alone when an older write fails', async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    vi.mocked(updateUserToServer)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce({});

    renderHook(() => useUserSettings(), { wrapper: makeWrapper() });

    await act(async () => {
      useLanguage.getState().setLanguage('fr');
    });
    await act(async () => {
      useLanguage.getState().setLanguage('de');
    });

    await act(async () => {
      rejectFirst?.(axiosError(500));
    });

    expect(useLanguage.getState().language).toBe('de');
  });
});

describe('UserSettingsContext - isHydrated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('exposes the explicit hydration flag from the UserContext store', () => {
    useUser.setState({ isHydrated: true });
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.isHydrated).toBe(true);
  });

  it('is false while the store flag has not flipped, even if currentUser has a preferences key', () => {
    // The refactor stops sniffing `'preferences' in currentUser`; an unhydrated
    // store must read as not-hydrated regardless of the persisted shim's shape.
    useUser.setState({ isHydrated: false });
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.isHydrated).toBe(false);
  });
});
