import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { TestLakeScopeDialog } from './TestLakeScopeDialog';

type MockLake = { id: string; name: string; datalakeTag: string; isOwn?: boolean; canPreauthorize?: boolean };

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
  { id: 'lake-a', name: 'Alpha Lake', datalakeTag: 'datalake:alpha', canPreauthorize: true },
  { id: 'lake-b', name: 'Beta Lake', datalakeTag: 'datalake:beta', isOwn: false, canPreauthorize: false },
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
    expect(onConfirm).toHaveBeenCalledWith({
      retrievalTags: ['datalake:alpha'],
      preauthorizedLakeIds: ['lake-a'],
    });
  });

  it('admits only the checked lakes the caller may pre-authorize, while scoping retrieval to all of them', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={onConfirm} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('test-lake-scope-checkbox-lake-b').querySelector('input')!);
    await user.click(screen.getByTestId('test-lake-scope-confirm-btn'));

    // Both lakes narrow retrieval; only lake-a is admitted. Sending lake-b would 403 the whole
    // request at /api/sessions/create, taking the working lake-a scoping down with it.
    expect(onConfirm).toHaveBeenCalledWith({
      retrievalTags: ['datalake:alpha', 'datalake:beta'],
      preauthorizedLakeIds: ['lake-a'],
    });
  });

  it('confirms with no admission when the caller may pre-authorize none of the checked lakes', async () => {
    // The platform-admin-only maintainer: canManage would be true for these, canPreauthorize is not.
    useGetDataLakesMock.mockReturnValue({
      data: [{ id: 'lake-a', name: 'Alpha Lake', datalakeTag: 'datalake:alpha', canPreauthorize: false }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={onConfirm} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('test-lake-scope-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledWith({ retrievalTags: ['datalake:alpha'], preauthorizedLakeIds: [] });
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
    // An empty retrievalTags list is NOT "no lakes" - it is no scoping at all, so confirming here
    // would start an unnarrowed session while the anchor still reads as checked.
    expect(screen.getByTestId('test-lake-scope-confirm-btn')).toBeDisabled();
  });

  // A failed REFETCH keeps `data` from cache while flipping isError, so the error branch renders
  // over a populated list. Tags alone stay non-empty there, which is why the gate needs isError.
  it('disables confirm on a failed refetch that still has cached lakes', () => {
    useGetDataLakesMock.mockReturnValue({ data: LAKES, isLoading: false, isError: true, refetch: vi.fn() });
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('test-lake-scope-error')).toBeInTheDocument();
    expect(screen.getByTestId('test-lake-scope-confirm-btn')).toBeDisabled();
  });

  it('disables confirm while the lakes are still loading', () => {
    useGetDataLakesMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(
      <Wrapper>
        <TestLakeScopeDialog anchorLakeId="lake-a" onClose={vi.fn()} onConfirm={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('test-lake-scope-loading')).toBeInTheDocument();
    expect(screen.getByTestId('test-lake-scope-confirm-btn')).toBeDisabled();
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
