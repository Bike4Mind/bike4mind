import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { TestLakeScopeDialog } from './TestLakeScopeDialog';

type MockLake = { id: string; name: string; datalakeTag: string; isOwn?: boolean };

const useGetDataLakesMock = vi.fn<
  [],
  { data: MockLake[] | undefined; isLoading: boolean; isError: boolean; refetch: () => void }
>();
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => useGetDataLakesMock(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const LAKES: MockLake[] = [
  { id: 'lake-a', name: 'Alpha Lake', datalakeTag: 'alpha' },
  { id: 'lake-b', name: 'Beta Lake', datalakeTag: 'beta', isOwn: false },
];

beforeEach(() => {
  useGetDataLakesMock.mockReset();
  useGetDataLakesMock.mockReturnValue({ data: LAKES, isLoading: false, isError: false, refetch: vi.fn() });
});

describe('TestLakeScopeDialog', () => {
  it('pre-selects the anchor lake and confirms with only that tag', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={onConfirm} />
      </Wrapper>
    );

    expect(screen.getByTestId('test-lake-scope-checkbox-lake-a').querySelector('input')).toBeChecked();
    expect(screen.getByTestId('test-lake-scope-checkbox-lake-b').querySelector('input')).not.toBeChecked();

    await user.click(screen.getByTestId('test-lake-scope-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledWith(['alpha']);
  });

  it('marks a not-owned lake with the owner icon', () => {
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('test-lake-scope-owner-icon-lake-b')).toBeInTheDocument();
    expect(screen.queryByTestId('test-lake-scope-owner-icon-lake-a')).not.toBeInTheDocument();
  });

  it('disables confirm once every lake is unchecked', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('test-lake-scope-checkbox-lake-a').querySelector('input')!);
    expect(screen.getByTestId('test-lake-scope-confirm-btn')).toBeDisabled();
  });

  it('shows a retry action on load failure instead of an empty list', () => {
    const refetch = vi.fn();
    useGetDataLakesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('test-lake-scope-error')).toBeInTheDocument();
  });

  it('calls onClose from the cancel action', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={onClose} onConfirm={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('test-lake-scope-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
