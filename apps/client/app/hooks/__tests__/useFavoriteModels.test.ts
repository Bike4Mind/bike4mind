import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFavoriteModels } from '../useFavoriteModels';

const mockUpdatePreferences = vi.fn();

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({ currentUser: mockCurrentUser })),
}));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ updatePreferences: mockUpdatePreferences }),
}));

// Mutable reference so tests can change the user between renders
let mockCurrentUser: { preferences?: { favoriteModelIds?: string[] } } | null = null;

// Re-import after mocks are set up
const { useUser } = await import('@client/app/contexts/UserContext');

function setServerFavorites(ids: string[]) {
  mockCurrentUser = { preferences: { favoriteModelIds: ids } };
  vi.mocked(useUser).mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
    selector({ currentUser: mockCurrentUser })
  );
}

describe('useFavoriteModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentUser = null;
  });

  it('returns empty set when user has no favorites', () => {
    mockCurrentUser = { preferences: {} };

    const { result } = renderHook(() => useFavoriteModels());

    expect(result.current.favoriteModelIds.size).toBe(0);
    expect(result.current.isFavorite('gpt-4')).toBe(false);
  });

  it('returns empty set when user is null', () => {
    mockCurrentUser = null;

    const { result } = renderHook(() => useFavoriteModels());

    expect(result.current.favoriteModelIds.size).toBe(0);
  });

  it('reflects server favorites on initial render', () => {
    setServerFavorites(['gpt-4', 'claude-3']);

    const { result } = renderHook(() => useFavoriteModels());

    expect(result.current.isFavorite('gpt-4')).toBe(true);
    expect(result.current.isFavorite('claude-3')).toBe(true);
    expect(result.current.isFavorite('gemini-pro')).toBe(false);
    expect(result.current.favoriteModelIds.size).toBe(2);
  });

  it('toggleFavorite adds a model and calls updatePreferences', () => {
    setServerFavorites(['gpt-4']);

    const { result } = renderHook(() => useFavoriteModels());

    act(() => {
      result.current.toggleFavorite('claude-3');
    });

    expect(result.current.isFavorite('claude-3')).toBe(true);
    expect(result.current.isFavorite('gpt-4')).toBe(true);
    expect(mockUpdatePreferences).toHaveBeenCalledWith({
      favoriteModelIds: ['gpt-4', 'claude-3'],
    });
  });

  it('toggleFavorite removes a model and calls updatePreferences', () => {
    setServerFavorites(['gpt-4', 'claude-3']);

    const { result } = renderHook(() => useFavoriteModels());

    act(() => {
      result.current.toggleFavorite('gpt-4');
    });

    expect(result.current.isFavorite('gpt-4')).toBe(false);
    expect(result.current.isFavorite('claude-3')).toBe(true);
    expect(mockUpdatePreferences).toHaveBeenCalledWith({
      favoriteModelIds: ['claude-3'],
    });
  });

  it('handles multiple toggles correctly', () => {
    setServerFavorites([]);

    const { result } = renderHook(() => useFavoriteModels());

    act(() => {
      result.current.toggleFavorite('model-a');
    });
    act(() => {
      result.current.toggleFavorite('model-b');
    });
    act(() => {
      result.current.toggleFavorite('model-a');
    });

    expect(result.current.isFavorite('model-a')).toBe(false);
    expect(result.current.isFavorite('model-b')).toBe(true);
    expect(result.current.favoriteModelIds.size).toBe(1);
  });

  it('syncs when server preferences change', () => {
    setServerFavorites(['gpt-4']);

    const { result, rerender } = renderHook(() => useFavoriteModels());
    expect(result.current.isFavorite('gpt-4')).toBe(true);

    // Simulate server pushing updated favorites (e.g., from another device)
    setServerFavorites(['gpt-4', 'gemini-pro']);
    rerender();

    expect(result.current.isFavorite('gemini-pro')).toBe(true);
    expect(result.current.favoriteModelIds.size).toBe(2);
  });

  it('does not call updatePreferences on server sync (no infinite loop)', () => {
    setServerFavorites(['gpt-4']);

    const { rerender } = renderHook(() => useFavoriteModels());

    // Simulate server update
    setServerFavorites(['gpt-4', 'claude-3']);
    rerender();

    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });
});
