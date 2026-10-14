import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GeneralSettingsTab from './GeneralSettingsTab';

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
// Separate handles so a test can tell which delete fired; a shared mock cannot.
const deleteSessionsMutation = { mutate: vi.fn(), isPending: false };
const deleteFilesMutation = { mutate: vi.fn(), isPending: false };
const deleteOptions: { sessions?: { onSuccess?: () => unknown }; files?: { onSuccess?: () => unknown } } = {};

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
let mfaEnabled = false;

vi.mock('@client/app/hooks/data/mfa', () => ({
  useMFAStatus: () => ({ data: mfaEnabled ? { enabled: true } : undefined }),
  useSetupMFA: () => mutation,
  useVerifyMFASetup: () => mutation,
  useCancelMFASetup: () => mutation,
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useDeleteAllFiles: (options: { onSuccess?: () => unknown }) => {
    deleteOptions.files = options;
    return deleteFilesMutation;
  },
  useGetFabFiles: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useDeleteAllSessions: (options: { onSuccess?: () => unknown }) => {
    deleteOptions.sessions = options;
    return deleteSessionsMutation;
  },
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
vi.mock('./PasskeysSection', () => ({
  default: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="passkeys-section-stub" data-enabled={`${enabled}`} />
  ),
}));
vi.mock('./TrustedDevicesSection', () => ({
  default: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="trusted-devices-section-stub" data-enabled={`${enabled}`} />
  ),
}));
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

describe('GeneralSettingsTab MFA sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaEnabled = false;
  });

  it.each(['passkeys-section-stub', 'trusted-devices-section-stub'])('mounts %s, disabled while MFA is off', testId => {
    renderTab();
    expect(screen.getByTestId(testId).getAttribute('data-enabled')).toBe('false');
  });

  it.each(['passkeys-section-stub', 'trusted-devices-section-stub'])('enables %s once MFA is on', testId => {
    mfaEnabled = true;
    renderTab();
    expect(screen.getByTestId(testId).getAttribute('data-enabled')).toBe('true');
  });
});

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
    fireEvent.change(screen.getByTestId('delete-all-confirm-input'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(deleteSessionsMutation.mutate).toHaveBeenCalledTimes(1);
    expect(deleteFilesMutation.mutate).not.toHaveBeenCalled();
  });

  it('confirming the knowledge files delete runs only the files mutation', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('settings-delete-all-files-btn'));
    fireEvent.change(screen.getByTestId('delete-all-confirm-input'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(deleteFilesMutation.mutate).toHaveBeenCalledTimes(1);
    expect(deleteSessionsMutation.mutate).not.toHaveBeenCalled();
  });

  it.each([['settings-delete-all-notebooks-btn'], ['settings-delete-all-files-btn']])(
    'reopening the %s dialog starts with an empty field and a disabled delete',
    openBtn => {
      renderTab();
      fireEvent.click(screen.getByTestId(openBtn));
      fireEvent.change(screen.getByTestId('delete-all-confirm-input'), { target: { value: 'DELETE' } });
      fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
      fireEvent.click(screen.getByTestId(openBtn));
      expect((screen.getByTestId('delete-all-confirm-input') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    }
  );

  it('a delete that succeeds after its dialog was closed does not reopen it', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('settings-delete-all-notebooks-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
    fireEvent.click(screen.getByTestId('settings-delete-all-files-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-btn'));
    await act(async () => {
      await deleteOptions.sessions?.onSuccess?.();
      await deleteOptions.files?.onSuccess?.();
    });
    expect(screen.queryByTestId('delete-all-notebooks-confirm')).toBeNull();
    expect(screen.queryByTestId('delete-all-files-confirm')).toBeNull();
  });
});
