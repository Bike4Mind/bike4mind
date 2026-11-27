import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: vi.fn() }));

const getMock = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: vi.fn() },
}));
const createSubscriberMock = vi.fn();
vi.mock('@client/app/utils/subscriberAPICalls', () => ({
  createSubscriber: (...args: unknown[]) => createSubscriberMock(...args),
}));
const createFeedbackMock = vi.fn();
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  createFeedbackOnServer: (...args: unknown[]) => createFeedbackMock(...args),
}));

import ComingSoon from './ComingSoon';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

describe('ComingSoon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: { turnstileSiteKey: '' } });
    createSubscriberMock.mockResolvedValue({ message: 'ok' });
  });

  it('signs the visitor up on the waitlist, tagged with the coming-soon source, and files no feedback', async () => {
    render(<ComingSoon />, { wrapper: TestWrapper });
    fireEvent.change(screen.getByTestId('subscriber-form-firstName-input'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByTestId('subscriber-form-lastName-input'), { target: { value: 'Lovelace' } });
    fireEvent.change(screen.getByTestId('subscriber-form-email-input'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByTestId('subscriber-form-submit-btn'));

    await waitFor(() => expect(createSubscriberMock).toHaveBeenCalledTimes(1));
    expect(createSubscriberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        source: 'coming_soon_page',
      })
    );
    expect(createFeedbackMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/be in touch soon/)).toBeTruthy();
  });
});
