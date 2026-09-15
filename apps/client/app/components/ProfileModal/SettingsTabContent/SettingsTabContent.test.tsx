import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Mocks
const mockNavigate = vi.fn();
let searchValue: Record<string, unknown> = {};
// Drives the Mementos gate via useFeatureEnabled (admin gate + user pref + hydration).
let enableMementos = false;
let featureLoading = false;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => searchValue,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Non-admin user with email configured: personal Custom Instructions must stay
// reachable for regular users, not gated behind admin.
let mockUser: Record<string, unknown> = {
  id: 'u1',
  name: 'Test User',
  platformEmailAddress: 'user@app.example.com',
};
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mockUser }),
}));

// Mementos visibility is driven by useFeatureEnabled so the admin `EnableMementos`
// gate is honored, not just the raw user preference.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => (feature === 'enableMementos' ? enableMementos : false),
    isAdminFeatureEnabled: () => false,
    isLoading: featureLoading,
  }),
}));

vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));
vi.mock('./GeneralSettingsTab', () => ({
  default: () => <div data-testid="general-settings-stub" />,
}));

import SettingsTabContent from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderSettings = () =>
  render(
    <Wrapper>
      <SettingsTabContent />
    </Wrapper>
  );

describe('SettingsTabContent sub-tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchValue = {};
    enableMementos = false;
    featureLoading = false;
    mockUser = { id: 'u1', name: 'Test User', platformEmailAddress: 'user@app.example.com' };
  });

  it('exposes Custom Instructions to a non-admin user (no regression)', () => {
    renderSettings();
    expect(screen.getByTestId('settings-subtab-custom-instructions')).toBeInTheDocument();
  });

  it('renders the General and Email Inbox sub-tabs', () => {
    renderSettings();
    expect(screen.getByTestId('settings-subtab-general')).toBeInTheDocument();
    expect(screen.getByTestId('settings-subtab-email-inbox')).toBeInTheDocument();
  });

  it('hides the Email Inbox sub-tab when user has no platform email configured', () => {
    mockUser = { id: 'u1', name: 'Test User' };
    renderSettings();
    expect(screen.queryByTestId('settings-subtab-email-inbox')).not.toBeInTheDocument();
  });

  // Billing (credit analytics) was promoted out to the top-level `usage` tab,
  // so it must no longer appear as a Settings sub-tab.
  it('no longer renders the Billing sub-tab', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-subtab-billing')).not.toBeInTheDocument();
  });

  // visibility follows the resolved useFeatureEnabled('enableMementos') value
  // (not the raw user preference), so the tab is hidden whenever the feature resolves
  // off - whether the admin gate is off or the user toggled it off. The admin-off /
  // user-on divergence itself is covered at the hook layer in useFeatureEnabled.test.ts.
  it('hides the Mementos sub-tab when the feature resolves disabled', () => {
    enableMementos = false;
    renderSettings();
    expect(screen.queryByTestId('settings-subtab-mementos')).not.toBeInTheDocument();
  });

  it('shows the Mementos sub-tab when the feature resolves enabled', () => {
    enableMementos = true;
    renderSettings();
    expect(screen.getByTestId('settings-subtab-mementos')).toBeInTheDocument();
  });

  // no flash before admin + user settings hydrate.
  it('hides the Mementos sub-tab while settings are still loading', () => {
    enableMementos = true;
    featureLoading = true;
    renderSettings();
    expect(screen.queryByTestId('settings-subtab-mementos')).not.toBeInTheDocument();
  });

  it('defaults to the General sub-tab when no subtab is in the URL', () => {
    renderSettings();
    expect(screen.getByTestId('general-settings-stub')).toBeInTheDocument();
  });

  // ?subtab=mementos with the flag off (the legacy ?tab=mementos redirect target)
  // must fall back to General instead of rendering an empty strip with no panel.
  it('falls back to General when ?subtab=mementos but the feature is off', () => {
    enableMementos = false;
    searchValue = { subtab: 'mementos' };
    renderSettings();
    expect(screen.getByTestId('general-settings-stub')).toBeInTheDocument();
  });

  // any unknown/typo'd subtab falls back to General.
  it('falls back to General for an unknown subtab value', () => {
    searchValue = { subtab: 'bogus' };
    renderSettings();
    expect(screen.getByTestId('general-settings-stub')).toBeInTheDocument();
  });
});
