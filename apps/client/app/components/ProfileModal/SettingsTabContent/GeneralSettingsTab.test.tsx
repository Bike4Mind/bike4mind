import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GeneralSettingsTab from './GeneralSettingsTab';

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {}, updatePreferences: vi.fn() }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ isLoading: true }),
  useExperimentalFeatureSettings: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useMFAStatus: () => ({ data: undefined }),
  useSetupMFA: () => mutation,
  useVerifyMFASetup: () => mutation,
  useCancelMFASetup: () => mutation,
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useDeleteAllFiles: () => mutation }));
vi.mock('@client/app/hooks/data/sessions', () => ({ useDeleteAllSessions: () => mutation }));
vi.mock('@client/app/hooks/useDownload', () => ({ useDownload: () => mutation }));
vi.mock('@client/app/components/common/MFAModal', () => ({ default: () => null }));
vi.mock('@client/app/components/LanguageSelector', () => ({ default: () => null }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('@/app/components/ProfileModal/UploadImportHistoryModal', () => ({ default: () => null }));
vi.mock('@/app/components/ProfileModal/NotebookExportModal', () => ({ default: () => null }));
vi.mock('@/app/components/ProfileModal/NotebookImportModal', () => ({ default: () => null }));
vi.mock('@/app/components/ProfileModal/NotebookCurationModal', () => ({ default: () => null }));
vi.mock('@/app/components/ProfileModal/ImportHistoryJobsList', () => ({ default: () => null }));
vi.mock('./VoicePreferenceSection', () => ({ default: () => null }));
vi.mock('./ActiveSessionsSection', () => ({ default: () => null }));
vi.mock('./ApprovedAppsSection', () => ({ default: () => null }));
vi.mock('./DocxTemplateSection', () => ({ default: () => null }));
vi.mock('../ExperimentalFeatureToggle', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GeneralSettingsTab />
    </CssVarsProvider>
  );

describe('GeneralSettingsTab danger zone', () => {
  it('renders the danger zone with both delete-all buttons', () => {
    renderTab();
    expect(screen.getByTestId('settings-danger-zone')).toBeTruthy();
    expect(screen.getByTestId('settings-delete-all-notebooks-btn').textContent).toContain('Delete all notebooks');
    expect(screen.getByTestId('settings-delete-all-files-btn').textContent).toContain('Delete all knowledge files');
  });

  it('opens the notebooks confirm modal', () => {
    renderTab();
    expect(screen.queryByText('Delete All Sessions')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-delete-all-notebooks-btn'));
    expect(screen.getByText('Delete All Sessions')).toBeTruthy();
    expect(screen.queryByText('Delete All Files')).toBeNull();
  });

  it('opens the knowledge files confirm modal', () => {
    renderTab();
    expect(screen.queryByText('Delete All Files')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-delete-all-files-btn'));
    expect(screen.getByText('Delete All Files')).toBeTruthy();
    expect(screen.queryByText('Delete All Sessions')).toBeNull();
  });
});
