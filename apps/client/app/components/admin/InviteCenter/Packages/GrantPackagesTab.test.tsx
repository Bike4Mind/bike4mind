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
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
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

  it('marks legacy packages and shows a dash for Today when there is no daily cap', async () => {
    fetchGrantPackages.mockResolvedValue({
      data: [
        { ...row, legacy: true },
        { ...row, id: 'p3', name: 'Daily', dailyCap: 5, redeemedToday: 2 },
      ],
      meta: { currentPage: 1, totalPages: 1, total: 2 },
      reasonPolicy: { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 },
    });
    renderTab();
    expect(await screen.findByTestId('grant-package-legacy-chip-p1')).toHaveTextContent('Legacy');
    expect(screen.queryByTestId('grant-package-legacy-chip-p3')).toBeNull();
    expect(screen.getByTestId('grant-package-row-p1')).not.toHaveTextContent('unlimited');
    expect(screen.getByTestId('grant-package-row-p3')).toHaveTextContent('2 / 5');
  });

  const listOf = (rows: unknown[]) =>
    fetchGrantPackages.mockResolvedValue({
      data: rows,
      meta: { currentPage: 1, totalPages: 1, total: rows.length },
      reasonPolicy: { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 },
    });
  const usage = { codes: 3, activeCodes: 2, nextCodeExpiry: null, partnerDomains: 2, enabledPartnerDomains: 1 };

  it('asks the list for usage', async () => {
    renderTab();
    await screen.findByTestId('grant-package-row-p1');
    expect(fetchGrantPackages).toHaveBeenCalledWith({ page: 1, limit: 25, usage: true });
  });

  it('shows linked codes, partner domains and the next code expiry', async () => {
    const expiry = '2026-07-01T12:00:00.000Z';
    listOf([
      { ...row, usage: { ...usage, nextCodeExpiry: expiry } },
      { ...row, id: 'p2', usage },
    ]);
    renderTab();
    expect(await screen.findByTestId('grant-package-codes-p1')).toHaveTextContent('2 active / 3');
    expect(screen.getByTestId('grant-package-domains-p1')).toHaveTextContent('1');
    expect(screen.getByTestId('grant-package-next-expiry-p1')).toHaveTextContent(
      new Date(expiry).toLocaleDateString('en-US')
    );
    expect(screen.getByTestId('grant-package-next-expiry-p2')).toHaveTextContent('-');
  });

  it.each([
    ['total cap reached', { totalCap: 1, redeemedTotal: 1 }, 'Cap reached'],
    ['total cap of 0', { totalCap: 0, redeemedTotal: 0, redeemedToday: 0 }, 'Cap reached'],
    ['daily cap reached', { totalCap: 10, dailyCap: 1, redeemedTotal: 1, redeemedToday: 1 }, 'Daily cap reached'],
    ['both reached, total wins', { totalCap: 1, dailyCap: 1, redeemedTotal: 1, redeemedToday: 1 }, 'Cap reached'],
  ])('flags %s on the row', async (_name, over, label) => {
    listOf([{ ...row, ...over }]);
    renderTab();
    expect(await screen.findByTestId('grant-package-cap-reached-p1')).toHaveTextContent(new RegExp(`^${label}$`));
  });

  it.each([
    ['under the caps', { totalCap: 5, dailyCap: 2, redeemedTotal: 1, redeemedToday: 1 }],
    ['no daily cap, many today', { totalCap: 50, dailyCap: null, redeemedTotal: 9, redeemedToday: 9 }],
  ])('shows no cap chip %s', async (_name, over) => {
    listOf([{ ...row, ...over }]);
    renderTab();
    await screen.findByTestId('grant-package-row-p1');
    expect(screen.queryByTestId('grant-package-cap-reached-p1')).toBeNull();
  });

  it('opens the edit form from the row', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('grant-package-edit-btn-p1'));
    expect(screen.getByTestId('grant-package-name-input')).toHaveValue('Launch');
  });

  it('disables Create while the list is loading', async () => {
    fetchGrantPackages.mockReturnValue(new Promise(() => undefined));
    renderTab();
    expect(screen.getByTestId('grant-packages-create-btn')).toBeDisabled();
  });

  it('creates a small package without asking for a reason', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('grant-packages-create-btn')).toBeEnabled());
    fireEvent.click(screen.getByTestId('grant-packages-create-btn'));
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
    await waitFor(() => expect(screen.getByTestId('grant-packages-create-btn')).toBeEnabled());
    fireEvent.click(screen.getByTestId('grant-packages-create-btn'));
    type('grant-package-name-input', 'Open launch');
    type('grant-package-credits-input', '100');
    expect(screen.getByTestId('grant-package-large-grant-alert')).toBeInTheDocument();
    expect(screen.getByTestId('grant-package-save-btn')).toBeDisabled();

    type('grant-package-total-cap-input', '10');
    expect(screen.queryByTestId('grant-package-large-grant-alert')).toBeNull();
    expect(screen.getByTestId('grant-package-save-btn')).not.toBeDisabled();
  });
});
