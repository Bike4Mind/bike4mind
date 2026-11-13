import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PromptCacheExpiryHint from './PromptCacheExpiryHint';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('PromptCacheExpiryHint', () => {
  it('states that the cache expired and what the next message costs, on two lines', () => {
    render(<PromptCacheExpiryHint credits={2400} expiresAt={1} />, { wrapper: TestWrapper });
    const lines = screen.getByTestId('prompt-cache-expiry-hint-text').children;
    expect(lines[0].textContent).toBe('Cache expired');
    expect(lines[1].textContent).toBe('Next message about 2,400 credits');
  });

  it('hides without a figure', () => {
    render(<PromptCacheExpiryHint credits={null} expiresAt={1} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('prompt-cache-expiry-hint')).toBeNull();
  });

  it('stays dismissed for that expiry, even as the figure moves, and returns for the next one', () => {
    const { rerender } = render(<PromptCacheExpiryHint credits={2400} expiresAt={1} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('prompt-cache-expiry-hint-dismiss'));
    rerender(<PromptCacheExpiryHint credits={2500} expiresAt={1} />);
    expect(screen.queryByTestId('prompt-cache-expiry-hint')).toBeNull();

    rerender(<PromptCacheExpiryHint credits={2500} expiresAt={2} />);
    expect(screen.getByTestId('prompt-cache-expiry-hint')).not.toBeNull();
  });
});
