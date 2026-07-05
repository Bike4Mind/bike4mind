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

vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useDataLakes: () => ({
    data: [{ id: 'lake-1', name: 'Test Lake', datalakeTag: 'lake:test' }],
    isLoading: false,
  }),
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
});
