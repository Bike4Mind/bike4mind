import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import CategoryFormModal from './CategoryFormModal';

const mutate = vi.fn();

vi.mock('./hooks', () => ({
  useCreateBusinessLinkCategory: () => ({ mutate: (...args: unknown[]) => mutate(...args), isPending: false }),
  useUpdateBusinessLinkCategory: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('CategoryFormModal', () => {
  it('creates only once when the submit button is double-clicked rapidly', async () => {
    // mutate is fire-and-forget; hold its callbacks so the test controls when onSettled fires.
    let settleCallbacks: { onSettled?: () => void } = {};
    mutate.mockImplementation((_vars: unknown, callbacks: { onSettled?: () => void }) => {
      settleCallbacks = callbacks;
    });

    render(
      <TestWrapper>
        <CategoryFormModal open onClose={vi.fn()} />
      </TestWrapper>
    );

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByLabelText('Name'), 'Tech');
    await user.type(screen.getByLabelText('Description'), 'Technology companies');

    const submitButton = screen.getByRole('button', { name: 'Create' });
    submitButton.click();
    submitButton.click();

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    settleCallbacks.onSettled?.();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
