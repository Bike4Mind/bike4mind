import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactNode } from 'react';

const mockMutateAsync = vi.fn();
const channelsState: { data?: unknown[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};

vi.mock('@client/app/hooks/data/useOrgSlackWorkspace', () => ({
  useGetOrgSlackApiPostingChannels: () => channelsState,
  useSetOrgSlackChannelApiPosting: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OrgSlackApiPosting from './OrgSlackApiPosting';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderIt = () =>
  render(
    <TestWrapper>
      <OrgSlackApiPosting organizationId="org-1" />
    </TestWrapper>
  );

beforeEach(() => {
  vi.clearAllMocks();
  channelsState.data = [];
  channelsState.isLoading = false;
  channelsState.isError = false;
});

describe('OrgSlackApiPosting', () => {
  it('keeps Enable disabled until the input is a channel id', () => {
    renderIt();
    const enable = screen.getByTestId('org-slack-api-posting-enable-btn');
    expect(enable).toBeDisabled();

    fireEvent.change(screen.getByTestId('org-slack-api-posting-channel-input'), { target: { value: 'general' } });
    expect(enable).toBeDisabled();

    fireEvent.change(screen.getByTestId('org-slack-api-posting-channel-input'), { target: { value: 'C0123ABCDEF' } });
    expect(enable).not.toBeDisabled();
  });

  it('enables a channel with the parsed key allowlist and asks for an invite when the bot is absent', async () => {
    mockMutateAsync.mockResolvedValue({
      channelId: 'C0123ABCDEF',
      apiPostEnabled: true,
      apiPostAllowedKeyIds: [],
      botIsMember: false,
    });
    renderIt();

    fireEvent.change(screen.getByTestId('org-slack-api-posting-channel-input'), { target: { value: ' C0123ABCDEF ' } });
    fireEvent.change(screen.getByTestId('org-slack-api-posting-keys-input'), { target: { value: 'k1, k2' } });
    fireEvent.click(screen.getByTestId('org-slack-api-posting-enable-btn'));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        channelId: 'C0123ABCDEF',
        apiPostEnabled: true,
        apiPostAllowedKeyIds: ['k1', 'k2'],
      })
    );
    expect(await screen.findByTestId('org-slack-api-posting-invite-hint')).toHaveTextContent('/invite');
  });

  it('lists enabled channels and disables one', async () => {
    channelsState.data = [{ channelId: 'C0123ABCDEF', apiPostEnabled: true, apiPostAllowedKeyIds: [] }];
    mockMutateAsync.mockResolvedValue({ channelId: 'C0123ABCDEF', apiPostEnabled: false, apiPostAllowedKeyIds: [] });
    renderIt();

    expect(screen.getByText('Any slack:post key')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-slack-api-posting-disable-C0123ABCDEF'));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ channelId: 'C0123ABCDEF', apiPostEnabled: false })
    );
  });

  it('swallows a failed save (the hook already reported it)', async () => {
    mockMutateAsync.mockRejectedValue(new Error('nope'));
    renderIt();

    fireEvent.change(screen.getByTestId('org-slack-api-posting-channel-input'), { target: { value: 'C0123ABCDEF' } });
    fireEvent.click(screen.getByTestId('org-slack-api-posting-enable-btn'));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled());
    expect(screen.queryByTestId('org-slack-api-posting-invite-hint')).not.toBeInTheDocument();
  });
});
