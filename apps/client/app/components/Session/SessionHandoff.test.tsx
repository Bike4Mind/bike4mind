import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageDataToClient } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  navigate: vi.fn(),
  receive: null as null | ((message: IMessageDataToClient) => Promise<void>),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: subscribe }),
}));
const subscribe = (_action: string, callback: (message: IMessageDataToClient) => Promise<void>) => {
  h.receive = callback;
  return () => {
    h.receive = null;
  };
};
import { SessionHandoffButton, SessionHandoffReceiver } from './SessionHandoff';

const sessionId = '0123456789abcdef01234567';
const theme = extendTheme({ ...getThemeConfig() });
const wrap = (child: React.ReactNode) => render(<CssVarsProvider theme={theme}>{child}</CssVarsProvider>);
describe('session handoff UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.get.mockResolvedValue({
      data: {
        devices: [
          { id: 'live:one', name: 'Mac', platform: 'desktop', available: true },
          { id: 'push:two', name: 'Phone', platform: 'ios', available: false },
        ],
      },
    });
    h.post.mockResolvedValue({ data: { status: 'sent' } });
  });
  it('sends the exact session to the selected device and disables inactive destinations', async () => {
    wrap(<SessionHandoffButton sessionId={sessionId} />);
    fireEvent.click(screen.getByTestId('session-handoff-open-btn'));
    await waitFor(() => expect(screen.getAllByTestId('session-handoff-device-btn')).toHaveLength(2));
    expect(screen.getAllByTestId('session-handoff-device-btn')[1]).toBeDisabled();
    fireEvent.click(screen.getAllByTestId('session-handoff-device-btn')[0]);
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/v1/session-handoffs', { sessionId, deviceId: 'live:one' })
    );
    expect(await screen.findByTestId('session-handoff-feedback')).toHaveTextContent('Sent.');
  });
  it('explains when a listed destination becomes inactive before sending', async () => {
    h.post.mockRejectedValue({ response: { status: 409 } });
    wrap(<SessionHandoffButton sessionId={sessionId} />);
    fireEvent.click(screen.getByTestId('session-handoff-open-btn'));
    await waitFor(() => expect(screen.getAllByTestId('session-handoff-device-btn')[0]).toBeEnabled());
    fireEvent.click(screen.getAllByTestId('session-handoff-device-btn')[0]);
    expect(await screen.findByTestId('session-handoff-feedback')).toHaveTextContent('inactive');
  });
  it('waits for a click before navigating to the exact notebook through the normal router', async () => {
    wrap(<SessionHandoffReceiver />);
    await act(async () => {
      await h.receive?.({ action: 'session_handoff', sessionId });
    });
    expect(h.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('session-handoff-continue-btn'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/notebooks/$id', params: { id: sessionId } });
  });
});
