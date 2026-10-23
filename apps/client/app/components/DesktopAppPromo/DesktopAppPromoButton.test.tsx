import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DesktopAppPromoButton, { DESKTOP_PROMO_MEDIA_QUERY } from './DesktopAppPromoButton';

const state = vi.hoisted(() => ({
  enabled: true,
  isHydrated: true,
  dismissed: false,
  updatePreferences: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@client/app/hooks/useDesktopPromoEnabled', () => ({ useDesktopPromoEnabled: () => state.enabled }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: { desktopPromoDismissed: state.dismissed },
    isHydrated: state.isHydrated,
    updatePreferences: state.updatePreferences,
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));

const appTheme = extendTheme({ ...getThemeConfig() });

function renderButton() {
  return render(
    <CssVarsProvider theme={appTheme}>
      <DesktopAppPromoButton />
    </CssVarsProvider>
  );
}

function setWideScreenWithMouse(matches: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    query =>
      ({
        matches: query === DESKTOP_PROMO_MEDIA_QUERY ? matches : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList
  );
}

beforeEach(() => {
  Object.assign(state, { enabled: true, isHydrated: true, dismissed: false });
  state.updatePreferences.mockReset();
  state.navigate.mockReset();
  setWideScreenWithMouse(true);
});

afterEach(() => {
  setWideScreenWithMouse(false);
});

describe('DesktopAppPromoButton', () => {
  it('opens the desktop download page', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('desktop-promo-open-btn'));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/desktop' });
  });

  it('remembers a dismissal in the user preferences', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('desktop-promo-dismiss-btn'));
    expect(state.updatePreferences).toHaveBeenCalledWith({ desktopPromoDismissed: true });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('stays hidden once the user dismissed it', () => {
    state.dismissed = true;
    renderButton();
    expect(screen.queryByTestId('desktop-promo')).not.toBeInTheDocument();
  });

  it('stays hidden until the user record has loaded, so a dismissed user never sees it flash', () => {
    state.isHydrated = false;
    renderButton();
    expect(screen.queryByTestId('desktop-promo')).not.toBeInTheDocument();
  });

  it('is hidden when the admin setting turns the desktop promo off', () => {
    state.enabled = false;
    renderButton();
    expect(screen.queryByTestId('desktop-promo')).not.toBeInTheDocument();
  });

  it('is hidden on small or touch-only screens, which have no desktop build', () => {
    setWideScreenWithMouse(false);
    renderButton();
    expect(screen.queryByTestId('desktop-promo')).not.toBeInTheDocument();
  });
});
