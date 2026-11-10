import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const state = vi.hoisted(() => ({
  rows: [] as { settingName: string; settingValue: unknown }[],
  loading: false,
  error: false,
  mutateAsync: vi.fn(async (_vars: { key: string; value: unknown }) => ({})),
  user: { isAdmin: true, adminPermissions: [] as string[] } as { isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({
    data: state.error ? undefined : state.rows,
    isLoading: state.loading,
    isError: state.error,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useUpdateSettings: () => ({ mutateAsync: state.mutateAsync, mutate: vi.fn(), isPending: false, error: null }),
  useFloorAboveMeasuredWarning: () => null,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: state.user }) }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({ state: { location: { pathname: '/admin', search: {} } }, navigate: vi.fn() }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));
vi.mock('../../AdminOperationsModelSetting', () => ({
  AdminOperationsModelSetting: () => <div data-testid="admin-operations-model-card" />,
}));
vi.mock('../../AdminRecommendedModelsSetting', () => ({
  AdminRecommendedModelsSetting: () => <div data-testid="admin-recommended-models-card" />,
}));
vi.mock('../../AdminGenerationModelsSetting', () => ({
  AdminGenerationModelsSetting: () => <div data-testid="admin-generation-models-card" />,
}));

import { ModelSettingsSection } from './ModelSettingsSection';

const theme = extendTheme({ ...getThemeConfig() });
const renderSection = () =>
  render(
    <CssVarsProvider theme={theme}>
      <ModelSettingsSection />
    </CssVarsProvider>
  );

beforeEach(() => {
  state.rows = [];
  state.loading = false;
  state.error = false;
  state.user = { isAdmin: true, adminPermissions: [] };
  state.mutateAsync.mockClear();
});

describe('ModelSettingsSection', () => {
  it('renders the four groups with their editors', () => {
    renderSection();

    for (const group of ['discovery', 'defaults', 'free-tier', 'generation']) {
      expect(screen.getByTestId(`models-settings-group-${group}`), group).toBeTruthy();
    }
    for (const key of [
      'enableModelDiscovery',
      'modelDiscoveryAllowEgress',
      'modelDiscoveryPriceBandPct',
      'modelDiscoveryProbeNewModels',
      'DefaultAPIModel',
      'freeTierModelGateEnabled',
    ]) {
      expect(screen.getByTestId(`admin-setting-${key}-helper`), key).toBeTruthy();
    }
    expect(screen.getByTestId('models-settings-modelDiscoveryMode')).toBeTruthy();
    expect(screen.getByTestId('models-settings-modelDiscoveryAutoEnable')).toBeTruthy();
    expect(screen.getByTestId('models-settings-modelDiscoveryAutoRemap')).toBeTruthy();
    expect(screen.getByTestId('models-settings-freeTierModelGateScope')).toBeTruthy();
    expect(screen.getByTestId('admin-setting-freeTierAllowedModels-input')).toBeTruthy();
    for (const card of ['recommended-models', 'operations-model', 'generation-models']) {
      expect(screen.getByTestId(`admin-${card}-card`), card).toBeTruthy();
    }
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
  });

  it('shows plain labels for the enum settings and keeps the stored default selected', () => {
    renderSection();

    const mode = screen.getByTestId('models-settings-modelDiscoveryMode');
    expect(screen.getByTestId('models-settings-modelDiscoveryMode-report')).toHaveTextContent('Report only');
    expect(screen.getByTestId('models-settings-modelDiscoveryMode-write')).toHaveTextContent('Writes changes');
    expect(screen.getByTestId('models-settings-modelDiscoveryMode-report')).toHaveAttribute('aria-pressed', 'true');
    expect(mode.textContent).not.toMatch(/\b(report|write)\b$/);
    expect(screen.getByTestId('models-settings-modelDiscoveryAutoEnable-priced')).toHaveTextContent(
      'New models listed when priced'
    );
    expect(screen.getByTestId('models-settings-modelDiscoveryAutoEnable-manual')).toHaveTextContent(
      'New models wait for approval'
    );
    expect(screen.getByTestId('models-settings-modelDiscoveryAutoEnable-all')).toHaveTextContent(
      'New models listed automatically'
    );
  });

  it('selects the stored value', () => {
    state.rows = [{ settingName: 'modelDiscoveryAutoEnable', settingValue: 'manual' }];
    renderSection();

    expect(screen.getByTestId('models-settings-modelDiscoveryAutoEnable-manual')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('stages an edit in the one save bar and saves the enum value through the settings update', async () => {
    renderSection();

    fireEvent.click(screen.getByTestId('models-settings-modelDiscoveryMode-write'));
    expect(screen.getAllByTestId('admin-save-bar')).toHaveLength(1);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('1 unsaved change');
    expect(state.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledWith({ key: 'modelDiscoveryMode', value: 'write' }));
  });

  it('discards a staged edit', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('models-settings-freeTierModelGateScope-media'));
    expect(screen.getByTestId('admin-save-bar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.getByTestId('models-settings-freeTierModelGateScope-all')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a loading state', () => {
    state.loading = true;
    renderSection();

    expect(screen.getByTestId('models-settings-loading')).toBeTruthy();
    expect(screen.queryByTestId('models-settings')).toBeNull();
  });

  it('shows an error state with retry', () => {
    state.error = true;
    renderSection();

    expect(screen.getByTestId('admin-error-state')).toBeTruthy();
    expect(screen.getByTestId('admin-error-retry-btn')).toBeTruthy();
  });

  it('disables the editors and names the missing permission for a delegate without settings:manage', async () => {
    state.user = { isAdmin: false, adminPermissions: ['support:read'] };
    renderSection();

    expect(screen.getByTestId('models-settings-blocked')).toHaveTextContent('settings:manage');
    expect(screen.getByTestId('models-settings-modelDiscoveryMode-write')).toBeDisabled();
    await userEvent.click(screen.getByTestId('models-settings-modelDiscoveryMode-write'));
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
  });

  it('allows edits for a full admin', () => {
    renderSection();

    expect(screen.queryByTestId('models-settings-blocked')).toBeNull();
    expect(screen.getByTestId('models-settings-modelDiscoveryMode-write')).toBeEnabled();
  });
});
