import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { useRegistrationInvitesStore } from '../store';
import { CreateInviteModal } from './CreateInviteModal';

const mocks = vi.hoisted(() => ({ fetchGrantPackages: vi.fn() }));

vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  fetchGrantPackages: mocks.fetchGrantPackages,
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: [] }) }));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const packageRow = (id: string, storageMb: number | null) => ({
  id,
  name: `Package ${id}`,
  credits: 100,
  storageMb,
  totalCap: 1,
  dailyCap: null,
  redeemedTotal: 0,
  redeemedToday: 0,
  capHits: 0,
  active: true,
});

const pickPackage = async (id: string) => {
  render(<CreateInviteModal onSubmit={vi.fn()} isLoading={false} />, { wrapper: Wrapper });
  const select = screen.getByTestId('create-invite-grant-package-select');
  await waitFor(() => expect(select).not.toBeDisabled());
  fireEvent.click(select);
  fireEvent.click(await screen.findByTestId(`create-invite-grant-package-select-option-${id}`));
};

const submitSelectedPackage = async (id: string) => {
  const onSubmit = vi.fn();
  render(<CreateInviteModal onSubmit={onSubmit} isLoading={false} />, { wrapper: Wrapper });
  const select = screen.getByTestId('create-invite-grant-package-select');
  await waitFor(() => expect(select).not.toBeDisabled());
  fireEvent.click(select);
  fireEvent.click(await screen.findByTestId(`create-invite-grant-package-select-option-${id}`));
  return onSubmit;
};

describe('CreateInviteModal grant package', () => {
  beforeEach(() => {
    mocks.fetchGrantPackages.mockResolvedValue({
      data: [packageRow('withStorage', 2048), packageRow('noStorage', null)],
      meta: { total: 2, page: 1, limit: 100, totalPages: 1 },
      reasonPolicy: {},
    });
    useRegistrationInvitesStore.getState().setOpenCreate(true);
  });

  it('shows the picked package credits and storage in the locked inputs', async () => {
    await pickPackage('withStorage');

    expect(screen.getByTestId('create-invite-credits-input')).toHaveValue(100);
    expect(screen.getByTestId('create-invite-credits-input')).toBeDisabled();
    expect(screen.getByTestId('create-invite-storage-input')).toHaveValue(2048);
    expect(screen.getByTestId('create-invite-storage-input')).toBeDisabled();
  });

  it('keeps the invite storage editable when the package sets none', async () => {
    await pickPackage('noStorage');

    expect(screen.getByTestId('create-invite-credits-input')).toHaveValue(100);
    expect(screen.getByTestId('create-invite-storage-input')).toHaveValue(1000);
    expect(screen.getByTestId('create-invite-storage-input')).not.toBeDisabled();
  });

  it('submits the picked package id in the invite payload', async () => {
    const onSubmit = await submitSelectedPackage('withStorage');
    fireEvent.click(screen.getByTestId('create-invite-submit-btn'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ grantPackageId: 'withStorage' });
  });

  it('omits grantPackageId when no package is picked', async () => {
    const onSubmit = vi.fn();
    render(<CreateInviteModal onSubmit={onSubmit} isLoading={false} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('create-invite-submit-btn'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('grantPackageId');
  });
});
