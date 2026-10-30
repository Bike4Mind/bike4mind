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
  openInNewTab: vi.fn(),
}));

vi.mock('@client/app/hooks/useDesktopPromoEnabled', () => ({ useDesktopPromoEnabled: () => state.enabled }));
vi.mock('@client/app/utils/externalLinks', () => ({ openInNewTab: state.openInNewTab }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: { desktopPromoDismissed: state.dismissed },
    isHydrated: state.isHydrated,
    updatePreferences: state.updatePreferences,
  }),
}));

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
  state.openInNewTab.mockReset();
  setWideScreenWithMouse(true);
});

afterEach(() => {
  setWideScreenWithMouse(false);
});

describe('DesktopAppPromoButton', () => {
  it('opens the desktop download page in a new tab when the pill is clicked', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('desktop-promo'));
    expect(state.openInNewTab).toHaveBeenCalledWith('/desktop');
  });

  it('opens the desktop download page from the keyboard', () => {
    renderButton();
    fireEvent.keyDown(screen.getByTestId('desktop-promo'), { key: 'Enter' });
    expect(state.openInNewTab).toHaveBeenCalledWith('/desktop');
  });

  it.each(['Enter', ' '])('leaves a %j keydown on the dismiss button to the button itself', key => {
    renderButton();
    const dismiss = screen.getByTestId('desktop-promo-dismiss-btn');
    dismiss.focus();
    // fireEvent returns false when a handler called preventDefault, which would swallow the click
    // the browser synthesises from this key.
    expect(fireEvent.keyDown(dismiss, { key })).toBe(true);
    expect(state.openInNewTab).not.toHaveBeenCalled();
  });

  it('remembers a dismissal in the user preferences', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('desktop-promo-dismiss-btn'));
    expect(state.updatePreferences).toHaveBeenCalledWith({ desktopPromoDismissed: true });
    expect(state.openInNewTab).not.toHaveBeenCalled();
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
