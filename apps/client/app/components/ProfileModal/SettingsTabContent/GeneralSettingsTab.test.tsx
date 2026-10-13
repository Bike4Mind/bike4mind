import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GeneralSettingsTab from './GeneralSettingsTab';

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
// Separate handles so a test can tell which delete fired; a shared mock cannot.
const deleteSessionsMutation = { mutate: vi.fn(), isPending: false };
const deleteFilesMutation = { mutate: vi.fn(), isPending: false };

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
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useDeleteAllFiles: () => deleteFilesMutation,
  useGetFabFiles: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useDeleteAllSessions: () => deleteSessionsMutation,
  useOwnSessionCount: () => ({ data: undefined }),
}));
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the danger zone with both delete-all buttons', () => {
    renderTab();
    expect(screen.getByTestId('settings-danger-zone')).toBeTruthy();
    expect(screen.getByTestId('settings-delete-all-notebooks-btn').textContent).toContain('Delete all notebooks');
    expect(screen.getByTestId('settings-delete-all-files-btn').textContent).toContain('Delete all knowledge files');
  });

  it('opens the notebooks confirm modal', () => {
    renderTab();
    expect(screen.queryByTestId('delete-all-notebooks-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-delete-all-notebooks-btn'));
    expect(screen.getByTestId('delete-all-notebooks-confirm')).toBeTruthy();
    expect(screen.queryByTestId('delete-all-files-confirm')).toBeNull();
  });

  it('opens the knowledge files confirm modal', () => {
    renderTab();
    expect(screen.queryByTestId('delete-all-files-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-delete-all-files-btn'));
    expect(screen.getByTestId('delete-all-files-confirm')).toBeTruthy();
    expect(screen.queryByTestId('delete-all-notebooks-confirm')).toBeNull();
  });

  it('confirming the notebooks delete runs only the sessions mutation', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('settings-delete-all-notebooks-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(deleteSessionsMutation.mutate).toHaveBeenCalledTimes(1);
    expect(deleteFilesMutation.mutate).not.toHaveBeenCalled();
  });

  it('confirming the knowledge files delete runs only the files mutation', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('settings-delete-all-files-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(deleteFilesMutation.mutate).toHaveBeenCalledTimes(1);
    expect(deleteSessionsMutation.mutate).not.toHaveBeenCalled();
  });
});
