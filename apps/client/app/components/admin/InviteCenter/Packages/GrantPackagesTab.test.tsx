import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import GrantPackagesTab from './GrantPackagesTab';

const { fetchGrantPackages, createGrantPackage, updateGrantPackage } = vi.hoisted(() => ({
  fetchGrantPackages: vi.fn(),
  createGrantPackage: vi.fn(),
  updateGrantPackage: vi.fn(),
}));
vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  fetchGrantPackages,
  createGrantPackage,
  updateGrantPackage,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <GrantPackagesTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const row = {
  id: 'p1',
  name: 'Launch',
  credits: 100,
  totalCap: 1,
  dailyCap: null,
  redeemedTotal: 1,
  redeemedToday: 1,
  capHits: 3,
  active: true,
  createdBy: 'admin-1',
};

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('GrantPackagesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGrantPackages.mockResolvedValue({
      data: [row],
      meta: { currentPage: 1, totalPages: 1, total: 1 },
      reasonPolicy: { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 },
    });
    createGrantPackage.mockResolvedValue({ ...row, id: 'p2' });
  });

  it('shows usage against caps and the cap-hit count', async () => {
    renderTab();
    expect(await screen.findByTestId('grant-package-cap-hits-p1')).toHaveTextContent('3');
    expect(screen.getByTestId('grant-package-row-p1')).toHaveTextContent('1 / 1');
  });

  it('creates a small package without asking for a reason', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('grant-packages-create-btn'));
    type('grant-package-name-input', 'Conference');
    type('grant-package-credits-input', '100');
    type('grant-package-total-cap-input', '1');
    expect(screen.queryByTestId('grant-package-large-grant-alert')).toBeNull();
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() =>
      expect(createGrantPackage).toHaveBeenCalledWith({
        name: 'Conference',
        credits: 100,
        totalCap: 1,
        dailyCap: null,
        active: true,
      })
    );
  });

  it('asks for a reason once the package crosses the threshold and blocks save until given', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('grant-packages-create-btn'));
    type('grant-package-name-input', 'Open launch');
    type('grant-package-credits-input', '100');
    expect(screen.getByTestId('grant-package-large-grant-alert')).toBeInTheDocument();
    expect(screen.getByTestId('grant-package-save-btn')).toBeDisabled();

    type('grant-package-total-cap-input', '10');
    expect(screen.queryByTestId('grant-package-large-grant-alert')).toBeNull();
    expect(screen.getByTestId('grant-package-save-btn')).not.toBeDisabled();
  });
});
