import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserSettingsProvider, useUserSettings } from './UserSettingsContext';

// Mutable mock of the UserContext store. `UserSettingsProvider` now reads both
// `currentUser` and the explicit `isHydrated` flag from it, so the mock state
// carries both. Reset to defaults in beforeEach.
type MockUserState = {
  currentUser: unknown;
  isHydrated: boolean;
};

const defaultMockUserState = (): MockUserState => ({
  currentUser: { id: 'u1', preferences: { experimentalFeatures: {} } },
  isHydrated: true,
});

let mockUserState: MockUserState = defaultMockUserState();

// `updatePreferences` now writes through to the store via `useUser.getState().setCurrentUser(...)`,
// so the mock must expose `getState` (real zustand does) whose `setCurrentUser` mutates the shared
// mock state. Object.assign keeps the selector-call form typed without `any`.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign(
    (selector?: (s: MockUserState) => unknown) => (selector ? selector(mockUserState) : mockUserState.currentUser),
    {
      getState: () => ({
        currentUser: mockUserState.currentUser,
        setCurrentUser: (user: unknown) => {
          mockUserState.currentUser = user;
        },
      }),
    }
  ),
}));

vi.mock('@client/app/contexts/TranslationProvider', () => ({
  useLanguage: () => ['en', vi.fn()],
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: undefined }),
}));

vi.mock('@client/app/utils/react-query', () => ({
  updateAllQueryData: vi.fn(),
  useSubscribeCollection: vi.fn(),
}));

vi.mock('@client/app/utils/userAPICalls', () => ({
  updateUserToServer: vi.fn().mockResolvedValue({}),
}));

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

describe('UserSettingsContext — rawExperimentalPreferences optimistic update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserState = defaultMockUserState();
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

    const stored = mockUserState.currentUser as {
      preferences: { experimentalFeatures: Record<string, boolean> };
    };
    expect(stored.preferences.experimentalFeatures.enableAgents).toBe(true);
  });
});

describe('UserSettingsContext — isHydrated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserState = defaultMockUserState();
  });

  it('exposes the explicit hydration flag from the UserContext store', () => {
    mockUserState.isHydrated = true;
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.isHydrated).toBe(true);
  });

  it('is false while the store flag has not flipped — even if currentUser has a preferences key', () => {
    // The refactor stops sniffing `'preferences' in currentUser`; an unhydrated
    // store must read as not-hydrated regardless of the persisted shim's shape.
    mockUserState.isHydrated = false;
    const { result } = renderHook(() => useUserSettings(), { wrapper: makeWrapper() });
    expect(result.current.isHydrated).toBe(false);
  });
});
