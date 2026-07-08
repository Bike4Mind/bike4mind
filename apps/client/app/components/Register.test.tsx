import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ExternalLinks } from '@client/app/utils/externalLinks';

// Data/context deps are stubbed; the real @mui/joy Checkbox + Link and react-hook-form render so we
// can assert the anchors the registration consent checkbox exposes. Open registration is enabled
// (allowOpenRegistration: true, not loading) so the form renders instead of the config gate.
const mocks = vi.hoisted(() => ({
  setCurrentUser: vi.fn(),
  setAccessToken: vi.fn(),
  sendOTC: vi.fn(),
  verifyOTC: vi.fn(),
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
  trackSignupConversion: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/hooks/data/auth', () => ({
  useSendOTC: () => ({ mutateAsync: mocks.sendOTC, isPending: false }),
  useVerifyOTC: () => ({ mutateAsync: mocks.verifyOTC, isPending: false }),
}));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useVerifyMFA: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useSetupMFA: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useVerifyMFASetup: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ setCurrentUser: mocks.setCurrentUser, currentUser: null }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: () => ({ setAccessToken: mocks.setAccessToken }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: {} }),
}));
vi.mock('@client/app/utils/authRedirect', () => ({
  applyRedirect: vi.fn(),
  appendRedirectTo: (url: string) => url,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ resetRefreshPromise: vi.fn() }));
vi.mock('@client/app/utils/signupConversion', () => ({ trackSignupConversion: mocks.trackSignupConversion }));
vi.mock('@client/app/hooks/useCommonStyles', () => ({
  useCommonStyles: () => ({ inputStyles: {}, dividerStyles: {} }),
}));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useBrandingSettings: () => ({}),
  usePublicConfig: () => ({ data: { allowOpenRegistration: true }, isLoading: false }),
}));
vi.mock('./common/MFAModal', () => ({ default: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import Register from './Register';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderRegister = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <Register />
    </CssVarsProvider>
  );

describe('Register', () => {
  // Regression guard for #59: the ToS/AUP/Privacy links in the acceptance-checkbox label must
  // point at the right policy pages and open in a new tab. (The underlying bug - clicks landing
  // on the checkbox's transparent input overlay instead of the anchor - is a visual stacking-order
  // issue jsdom cannot reproduce, so it is verified in a browser, not here. See the fix: each Link
  // is raised above the overlay via the shared CHECKBOX_LABEL_LINK_SX.)
  it('renders the policy links with the correct href, new-tab target, and rel', () => {
    renderRegister();

    const cases: Array<[string, string]> = [
      ['Terms of Service', ExternalLinks.terms],
      ['Acceptable Use Policy', ExternalLinks.acceptableUse],
      ['Privacy Policy', ExternalLinks.privacy],
    ];
    for (const [name, href] of cases) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});
