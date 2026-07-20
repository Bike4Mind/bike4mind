import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import SendToDataLakeModal from './SendToDataLakeModal';

const createFabFileOnServerWithUpload = vi.fn();
const updateFabFileOnServer = vi.fn();

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: (...args: unknown[]) => createFabFileOnServerWithUpload(...args),
  updateFabFileOnServer: (...args: unknown[]) => updateFabFileOnServer(...args),
}));

// Mirror React Query's `enabled` semantics: a disabled query never fetches, so it has no data.
// `lake-1` is manageable (a valid send target); `lake-2` is a read-only public lake the caller
// doesn't own, so the modal must exclude it (sending is a write).
const useDataLakes = vi.fn((enabled: boolean = true) =>
  enabled
    ? {
        data: [
          { id: 'lake-1', name: 'Test Lake', datalakeTag: 'lake:test', canManage: true },
          { id: 'lake-2', name: 'Public Lake', datalakeTag: 'lake:pub', canManage: false },
        ],
        isLoading: false,
      }
    : { data: undefined, isLoading: false }
);

vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useDataLakes: (enabled?: boolean) => useDataLakes(enabled),
}));

// The component reads the EnableDataLakes flag via useAdminSettingsCache; default it on so
// the modal renders lakes. Individual tests can override isFeatureEnabled.
const isFeatureEnabled = vi.fn(() => true);

vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('SendToDataLakeModal', () => {
  beforeEach(() => {
    createFabFileOnServerWithUpload.mockReset();
    updateFabFileOnServer.mockReset();
    useDataLakes.mockClear();
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useSendToDataLakeStore.setState({
      isOpen: true,
      content: 'hello world',
      fileName: 'reply.md',
      mimeType: 'text/markdown',
      sourceLabel: 'reply',
    });
  });

  afterEach(() => {
    useSendToDataLakeStore.setState({ isOpen: false });
  });

  it('sends only once when the Send button is double-clicked rapidly', async () => {
    // Resolve only after both clicks have had a chance to fire, so the test
    // actually exercises the race rather than the first call finishing first.
    let resolveCreate: (value: { id: string }) => void = () => {};
    createFabFileOnServerWithUpload.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCreate = resolve;
        })
    );
    updateFabFileOnServer.mockResolvedValue({});

    render(
      <TestWrapper>
        <SendToDataLakeModal />
      </TestWrapper>
    );

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId('send-to-datalake-option-lake-1'));

    const sendButton = screen.getByTestId('send-to-datalake-confirm-btn');
    sendButton.click();
    sendButton.click();

    await waitFor(() => expect(createFabFileOnServerWithUpload).toHaveBeenCalledTimes(1));

    resolveCreate({ id: 'file-1' });
    await waitFor(() => expect(updateFabFileOnServer).toHaveBeenCalledTimes(1));
    expect(createFabFileOnServerWithUpload).toHaveBeenCalledTimes(1);

    // A further click after the first send has settled is a legitimate new send - assert
    // it actually goes through, which also protects the `finally` reset of `sendingRef`
    // from a regression that would silently swallow every send after the first.
    createFabFileOnServerWithUpload.mockResolvedValue({ id: 'file-2' });
    act(() => {
      useSendToDataLakeStore.setState({
        isOpen: true,
        content: 'hello world',
        fileName: 'reply.md',
        mimeType: 'text/markdown',
        sourceLabel: 'reply',
      });
    });
    await user.click(await screen.findByTestId('send-to-datalake-option-lake-1'));
    screen.getByTestId('send-to-datalake-confirm-btn').click();

    await waitFor(() => expect(createFabFileOnServerWithUpload).toHaveBeenCalledTimes(2));
  });

  it('excludes lakes the caller cannot manage (read-only public lakes are not send targets)', () => {
    render(
      <TestWrapper>
        <SendToDataLakeModal />
      </TestWrapper>
    );

    // Sending tags a file into the lake - a write - so a non-owned public lake must not appear
    // as an option, mirroring the backend write gate (assertCanWriteDataLakeTags).
    expect(screen.getByTestId('send-to-datalake-option-lake-1')).toBeInTheDocument();
    expect(screen.queryByTestId('send-to-datalake-option-lake-2')).toBeNull();
  });

  it('does not run the lakes query when EnableDataLakes is off, even while open', () => {
    isFeatureEnabled.mockReturnValue(false);

    render(
      <TestWrapper>
        <SendToDataLakeModal />
      </TestWrapper>
    );

    // The query gate is `isOpen && isFeatureEnabled('EnableDataLakes')`. The store is open
    // (set in beforeEach), so with the flag off the hook must still be called with enabled=false
    // to avoid the 403 on /api/data-lakes.
    expect(isFeatureEnabled).toHaveBeenCalledWith('EnableDataLakes');
    expect(useDataLakes).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('send-to-datalake-option-lake-1')).toBeNull();
  });

  it('does not render at all when EnableDataLakes is off, even if the store is open', () => {
    isFeatureEnabled.mockReturnValue(false);

    render(
      <TestWrapper>
        <SendToDataLakeModal />
      </TestWrapper>
    );

    // The modal is the shared choke point for every "Send to Data Lake" entry point.
    // Rendering it with the feature off would surface a dead-end empty state pointing
    // at a Files -> Data Lakes entry that is itself hidden, so it must return null
    // (mirroring CreateDataLakeButton in FileBrowser).
    expect(screen.queryByTestId('send-to-datalake-modal')).toBeNull();
  });
});
