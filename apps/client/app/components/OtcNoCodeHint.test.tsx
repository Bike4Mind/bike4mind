import { act, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import en from '@client/app/locales/en.json';
import OtcNoCodeHint, { OTC_NO_CODE_HINT_DELAY_MS } from './OtcNoCodeHint';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('OtcNoCodeHint', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays hidden until the delay passes, then shows the hint', () => {
    render(<OtcNoCodeHint />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('otc-no-code-hint')).toBeNull();

    act(() => vi.advanceTimersByTime(OTC_NO_CODE_HINT_DELAY_MS - 1));
    expect(screen.queryByTestId('otc-no-code-hint')).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('otc-no-code-hint')).toHaveTextContent('auth.noCodeHint');
  });

  it('clears its timer on unmount', () => {
    const { unmount } = render(<OtcNoCodeHint />, { wrapper: TestWrapper });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('points at spam and support in English', () => {
    expect(en.auth.noCodeHint).toMatch(/spam/i);
    expect(en.auth.noCodeHint).toMatch(/support/i);
  });
});
