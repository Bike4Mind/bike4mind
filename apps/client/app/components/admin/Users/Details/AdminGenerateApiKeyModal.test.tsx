import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminGenerateApiKeyModal from './AdminGenerateApiKeyModal';

const h = vi.hoisted(() => ({
  lakes: [
    { id: 'lakeA', name: 'Lake A' },
    { id: 'lakeB', name: 'Lake B' },
  ] as { id: string; name: string }[] | undefined,
  lakesLoading: false,
  lakesError: false,
  refetchLakes: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({
    data: h.lakes,
    isLoading: h.lakesLoading,
    isError: h.lakesError,
    refetch: h.refetchLakes,
  }),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGenerateApiKey: () => ({ mutate: h.mutate, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const USER = { id: 'u1', username: 'target-user' } as never;

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminGenerateApiKeyModal open onClose={vi.fn()} user={USER} />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.lakes = [
    { id: 'lakeA', name: 'Lake A' },
    { id: 'lakeB', name: 'Lake B' },
  ];
  h.lakesLoading = false;
  h.lakesError = false;
  h.refetchLakes.mockClear();
  h.mutate.mockClear();
});

describe('AdminGenerateApiKeyModal - pre-authorized lakes', () => {
  it('shows a loading state while lakes are fetching', () => {
    h.lakesLoading = true;
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lakes-loading')).toBeTruthy();
  });

  it('shows an error state with a retry when the lake fetch fails', () => {
    h.lakesError = true;
    renderModal();
    expect(screen.getByTestId('admin-generate-key-lakes-error')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(h.refetchLakes).toHaveBeenCalled();
  });

  it('shows an empty state when there are no lakes', () => {
    h.lakes = [];
    renderModal();
    expect(screen.getByText('No lakes yet')).toBeTruthy();
  });

  it('submits with no preauthorizedLakeIds when none are checked', () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByText('Generate API Key'));

    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toBeUndefined();
  });

  it('checking a lake includes its id, and unchecking removes it, in the submitted data', () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Data Lake Upload/i), { target: { value: 'my key' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeB').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('2 selected');

    fireEvent.click(screen.getByText('Generate API Key'));
    const call = h.mutate.mock.calls[0][0];
    expect(call.data.preauthorizedLakeIds).toEqual(['lakeA', 'lakeB']);

    fireEvent.click(screen.getByTestId('admin-generate-key-lake-checkbox-lakeA').querySelector('input')!);
    expect(screen.getByTestId('admin-generate-key-lakes-count').textContent).toContain('1 selected');
  });
});
