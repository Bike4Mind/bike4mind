import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFeatureEnabled } from './useFeatureEnabled';

const mockUseUserSettings = vi.fn();
const mockUseAdminSettingsCache = vi.fn();

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => mockUseUserSettings(),
}));

vi.mock('./useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => mockUseAdminSettingsCache(),
}));

const userSettingsFixture = (rawPrefs: Record<string, boolean> = {}, isHydrated = true) => ({
  rawExperimentalPreferences: rawPrefs,
  isHydrated,
});

const adminFixture = (enabledKeys: string[], isLoading = false) => ({
  isFeatureEnabled: (name: string) => enabledKeys.includes(name),
  isLoading,
});

describe('useFeatureEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isLoading aggregation', () => {
    it('is true while admin settings are loading, even after user is hydrated', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture());
      mockUseAdminSettingsCache.mockReturnValue(adminFixture([], true));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isLoading).toBe(true);
    });

    it('is true while user preferences are not hydrated, even after admin settles', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}, false));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isLoading).toBe(true);
    });

    it('is false only when both admin and user have settled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableAgents: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('isFeatureEnabled — admin gate', () => {
    it('returns false when admin gate is off, regardless of user pref', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableAgents: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture([]));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableAgents')).toBe(false);
    });
  });

  describe('isFeatureEnabled — admin default fallback (graduating features)', () => {
    it('user has no explicit preference, admin default on → feature enabled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents', 'EnableAgentsDefault']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableAgents')).toBe(true);
    });

    it('user has no explicit preference, admin default off → feature disabled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableAgents')).toBe(false);
    });

    it('user explicitly set false, admin default on → feature disabled (user wins)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableAgents: false }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents', 'EnableAgentsDefault']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableAgents')).toBe(false);
    });

    it('user explicitly set true, admin default off → feature enabled (user wins)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableAgents: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgents']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableAgents')).toBe(true);
    });
  });

  describe('isFeatureEnabled — features without admin default', () => {
    it('feature with no defaultKey, user has no pref → disabled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableQuestMaster']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableQuestMaster')).toBe(false);
    });

    it('feature with no defaultKey, user explicitly set true → enabled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableQuestMaster: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableQuestMaster']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableQuestMaster')).toBe(true);
    });

    it('feature with no adminKey is user-controlled regardless of admin state', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ enableResearchMode: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture([])); // no admin keys enabled

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('enableResearchMode')).toBe(true);
    });
  });

  // Agent Mode / Smart Routing graduated from an admin-less dogfooding flag to a
  // properly gated Beta feature (EnableAgentMode / EnableAgentModeDefault). These
  // lock in the two behaviors that matter for the rollout: existing dogfooders
  // (explicit pref) keep working while the master gate is on, and the master gate
  // is a hard org-wide kill switch.
  describe('isFeatureEnabled — agentMode admin gating', () => {
    it('master gate on, no user pref, default off → disabled (opt-in rollout)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgentMode']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('agentMode')).toBe(false);
    });

    it('master gate on, explicit user pref true → enabled (dogfooders preserved)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ agentMode: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgentMode']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('agentMode')).toBe(true);
    });

    it('master gate off → disabled even with explicit user pref true (kill switch)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ agentMode: true }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture([]));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('agentMode')).toBe(false);
    });

    it('master gate on, admin default on, no user pref → enabled', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({}));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgentMode', 'EnableAgentModeDefault']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('agentMode')).toBe(true);
    });

    it('master gate on, admin default on, explicit user pref false → disabled (user wins)', () => {
      mockUseUserSettings.mockReturnValue(userSettingsFixture({ agentMode: false }));
      mockUseAdminSettingsCache.mockReturnValue(adminFixture(['EnableAgentMode', 'EnableAgentModeDefault']));

      const { result } = renderHook(() => useFeatureEnabled());
      expect(result.current.isFeatureEnabled('agentMode')).toBe(false);
    });
  });
});
