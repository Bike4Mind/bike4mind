import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { getThemeConfig } from '@client/app/utils/themes';
import SystemMessageModal from './SystemMessageModal';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), onSuccess: undefined as undefined | (() => void) }));

vi.mock('@client/app/hooks/data/inbox', () => ({
  useSendSystemMessage: (options: { onSuccess: () => void }) => {
    mocks.onSuccess = options.onSuccess;
    return { mutate: mocks.mutate, isPending: false };
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// The title, message and send controls carry no test ids, so they are found by placeholder and role.
const fillMessage = () => {
  fireEvent.change(screen.getByTestId('system-message-title-input'), { target: { value: 'Heads up' } });
  fireEvent.change(screen.getByTestId('system-message-body-input'), { target: { value: 'Please read.' } });
};
const sendButton = () => screen.getByTestId('system-message-send-btn');

describe('SystemMessageModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays blocked until a reason is given, even with a title and message', () => {
    render(<SystemMessageModal open onClose={vi.fn()} receiverId="u1" />, { wrapper: TestWrapper });

    fillMessage();

    expect(sendButton()).toBeDisabled();
    fireEvent.submit(screen.getByTestId('system-message-form'));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('sends the reason with the message once it is picked', () => {
    render(<SystemMessageModal open onClose={vi.fn()} receiverId="u1" />, { wrapper: TestWrapper });

    fillMessage();
    fireEvent.click(screen.getByTestId('system-message-reason-input-preset-0'));

    expect(sendButton()).toBeEnabled();
    fireEvent.submit(screen.getByTestId('system-message-form'));

    expect(mocks.mutate).toHaveBeenCalledWith({
      title: 'Heads up',
      message: 'Please read.',
      receiverId: 'u1',
      reason: 'Account notice',
    });
  });
});
