import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider } from '@mui/joy/styles';

const transport = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: transport }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import OrgSlackFeedback from './OrgSlackFeedback';

const clients = new Set<QueryClient>();
function renderSettings(canEnable = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.add(client);
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider>
        <OrgSlackFeedback organizationId="org1" canEnable={canEnable} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}
function fill(testId: string, value: string) {
  fireEvent.change(within(screen.getByTestId(testId)).getByRole('textbox'), { target: { value } });
}
beforeEach(() => {
  vi.clearAllMocks();
  transport.get.mockReset();
  transport.put.mockReset();
  transport.get.mockResolvedValue({ data: { channels: [], destinations: ['receiver'] } });
  transport.put.mockResolvedValue({ data: { ok: true } });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
});

it.each(['C12345678', 'G12345678'])(
  'submits an eligible %s channel to the actual mutation transport',
  async channelId => {
    renderSettings();
    await screen.findByText('Provisioned destinations: receiver');
    fill('slack-feedback-channel', channelId);
    fill('slack-feedback-destination', 'receiver');
    const enable = screen.getByTestId('slack-feedback-enable');
    expect(enable).toBeEnabled();
    fireEvent.click(enable);
    await waitFor(() =>
      expect(transport.put).toHaveBeenCalledWith('/api/organizations/org1/integrations/slack/feedback', {
        channelId,
        destinationId: 'receiver',
        emoji: 'bug',
        enabled: true,
      })
    );
  }
);

it.each(['D12345678', 'Gshort', 'general', 'g12345678'])('keeps invalid channel %s disabled', async channelId => {
  renderSettings();
  await screen.findByText('Provisioned destinations: receiver');
  fill('slack-feedback-channel', channelId);
  fill('slack-feedback-destination', 'receiver');
  expect(screen.getByTestId('slack-feedback-enable')).toBeDisabled();
  expect(transport.put).not.toHaveBeenCalled();
});

it('allows cleanup of a G opt-in when the workspace cannot enable forwarding', async () => {
  transport.get.mockResolvedValue({
    data: {
      channels: [{ channelId: 'G12345678', destinationId: 'receiver', emoji: 'bug' }],
      destinations: [],
    },
  });
  renderSettings(false);
  const disable = await screen.findByTestId('slack-feedback-disable-G12345678');
  expect(screen.queryByTestId('slack-feedback-enable')).not.toBeInTheDocument();
  fireEvent.click(disable);
  await waitFor(() =>
    expect(transport.put).toHaveBeenCalledWith('/api/organizations/org1/integrations/slack/feedback', {
      channelId: 'G12345678',
      enabled: false,
    })
  );
});
