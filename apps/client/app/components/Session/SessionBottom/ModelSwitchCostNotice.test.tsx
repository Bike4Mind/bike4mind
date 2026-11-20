import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ModelSwitchCostNotice } from './ModelSwitchCostNotice';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ModelSwitchCostNotice', () => {
  it('states the credits the next message spends re-reading the conversation', () => {
    render(<ModelSwitchCostNotice credits={1200} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('chat-model-switch-cost-notice-text').textContent).toBe(
      'Switching models re-reads this conversation: about 1,200 credits for the next message.'
    );
  });

  it('renders nothing without a figure', () => {
    render(<ModelSwitchCostNotice credits={null} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('chat-model-switch-cost-notice')).toBeNull();
  });

  it('hides on dismiss and comes back for a different figure', () => {
    const { rerender } = render(<ModelSwitchCostNotice credits={1200} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('chat-model-switch-cost-notice-dismiss'));
    expect(screen.queryByTestId('chat-model-switch-cost-notice')).toBeNull();

    rerender(<ModelSwitchCostNotice credits={800} />);
    expect(screen.getByTestId('chat-model-switch-cost-notice')).not.toBeNull();
  });
});
