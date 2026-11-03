import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: vi.fn() }));

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: (...args: unknown[]) => postMock(...args) },
}));
const solveMock = vi.fn();
vi.mock('@client/app/utils/turnstile', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/turnstile')>()),
  getTurnstileToken: (...args: unknown[]) => solveMock(...args),
}));
const createSubscriberMock = vi.fn();
vi.mock('@client/app/utils/subscriberAPICalls', () => ({
  createSubscriber: (...args: unknown[]) => createSubscriberMock(...args),
}));

import SubscriberForm from './SubscriberForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

function fillAndSubmit() {
  fireEvent.change(screen.getByTestId('subscriber-form-firstName-input'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByTestId('subscriber-form-lastName-input'), { target: { value: 'Lovelace' } });
  fireEvent.change(screen.getByTestId('subscriber-form-email-input'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByTestId('subscriber-form-submit-btn'));
}

function makeAxiosError(status: number, data: unknown): AxiosError {
  const error = new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST');
  error.response = { status, statusText: '', headers: {}, config: {}, data } as AxiosResponse;
  return error;
}

describe('SubscriberForm challenge gate', () => {
  beforeEach(() => {
    // Not resetAllMocks: that also wipes the global matchMedia stub the theme provider needs.
    vi.clearAllMocks();
    solveMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue({ data: { turnstileSiteKey: '' } });
    createSubscriberMock.mockResolvedValue({ message: 'ok' });
  });

  it('submits without a challenge when no site key is configured', async () => {
    render(<SubscriberForm source="subscribe_page" />, { wrapper: Wrapper });
    fillAndSubmit();

    await screen.findByText(/thanks for being interested/i);
    expect(solveMock).not.toHaveBeenCalled();
    expect(createSubscriberMock).toHaveBeenCalledWith({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      source: 'subscribe_page',
      turnstileToken: undefined,
    });
  });

  it('solves the subscribe challenge and sends the token with the signup', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockResolvedValue('token-1');
    render(<SubscriberForm />, { wrapper: Wrapper });
    fillAndSubmit();

    await screen.findByText(/thanks for being interested/i);
    expect(solveMock).toHaveBeenCalledWith('site', 'subscribe');
    expect(createSubscriberMock).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: 'token-1' }));
  });

  it('does not submit when the challenge fails, and shows why', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new Error('turnstile-error'));
    postMock.mockResolvedValue({ data: undefined });
    render(<SubscriberForm />, { wrapper: Wrapper });
    fillAndSubmit();

    await screen.findByText(/verification check/i);
    expect(createSubscriberMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/turnstile/client-failure',
        expect.objectContaining({ action: 'subscribe' })
      )
    );
  });

  it('shows the server refusal when the API rejects the signup', async () => {
    createSubscriberMock.mockRejectedValue(
      makeAxiosError(403, { error: 'Verification failed. Please refresh and try again.', code: 'challenge_failed' })
    );
    render(<SubscriberForm />, { wrapper: Wrapper });
    fillAndSubmit();

    await screen.findByText('Verification failed. Please refresh and try again.');
    expect(screen.queryByText(/thanks for being interested/i)).toBeNull();
  });

  it('shows the rate-limit message when the API answers 429', async () => {
    createSubscriberMock.mockRejectedValue(
      makeAxiosError(429, { error: 'Rate limit exceeded. Try again in 60 seconds.' })
    );
    render(<SubscriberForm />, { wrapper: Wrapper });
    fillAndSubmit();

    await screen.findByText('Rate limit exceeded. Try again in 60 seconds.');
    expect(screen.queryByText(/thanks for being interested/i)).toBeNull();
  });
});
