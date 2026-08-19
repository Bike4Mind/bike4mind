import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ComingSoon from './ComingSoon';

const createFeedbackOnServer = vi.fn();

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  createFeedbackOnServer: (...args: unknown[]) => createFeedbackOnServer(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ComingSoon', () => {
  beforeEach(async () => {
    createFeedbackOnServer.mockReset();
    const { toast } = await import('sonner');
    (toast.success as ReturnType<typeof vi.fn>).mockReset();
    (toast.error as ReturnType<typeof vi.fn>).mockReset();
  });

  it('sends a schema-satisfying payload and shows success on a resolved submit', async () => {
    createFeedbackOnServer.mockResolvedValue({});
    const { toast } = await import('sonner');
    const user = userEvent.setup();

    render(<ComingSoon />, { wrapper: TestWrapper });
    await user.type(screen.getByTestId('coming-soon-email-input'), 'signup@example.com');
    await user.click(screen.getByTestId('coming-soon-submit-btn'));

    await waitFor(() => expect(createFeedbackOnServer).toHaveBeenCalledTimes(1));
    const payload = createFeedbackOnServer.mock.calls[0][0];
    expect(payload.content).toBe('Coming soon signup');
    expect(payload.username).toBe('signup@example.com');
    expect(payload.userEmail).toBe('signup@example.com');

    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error toast, not a success toast, when the submit rejects', async () => {
    createFeedbackOnServer.mockRejectedValue(new Error('422'));
    const { toast } = await import('sonner');
    const user = userEvent.setup();

    render(<ComingSoon />, { wrapper: TestWrapper });
    await user.type(screen.getByTestId('coming-soon-email-input'), 'signup@example.com');
    await user.click(screen.getByTestId('coming-soon-submit-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is in flight, so a second click cannot double-submit', async () => {
    let resolveSubmit: () => void = () => {};
    createFeedbackOnServer.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveSubmit = resolve;
        })
    );
    const user = userEvent.setup();

    render(<ComingSoon />, { wrapper: TestWrapper });
    await user.type(screen.getByTestId('coming-soon-email-input'), 'signup@example.com');
    const submitBtn = screen.getByTestId('coming-soon-submit-btn');
    await user.click(submitBtn);

    await waitFor(() => expect(submitBtn).toBeDisabled());
    expect(createFeedbackOnServer).toHaveBeenCalledTimes(1);

    resolveSubmit();
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
  });
});
