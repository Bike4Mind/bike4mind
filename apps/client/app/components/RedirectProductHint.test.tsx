import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PremiumNavDescriptor } from '@client/app/premiumContract';
import i18next from 'i18next';
import en from '@client/app/locales/en.json';
import RedirectProductHint from './RedirectProductHint';

const nav = vi.hoisted(() => ({ items: [] as PremiumNavDescriptor[] }));
vi.mock('@client/app/premium-generated/premiumNavItems.generated', () => ({
  get premiumNavItems() {
    return nav.items;
  },
}));
// A real i18next over en.json with its default escaping, so the test pins the wording and the
// interpolation options users actually get.
const i18n = vi.hoisted(() => ({ t: (key: string): string => key }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
}));
const instance = i18next.createInstance();
void instance.init({ lng: 'en', resources: { en: { translation: en } }, initAsync: false });
i18n.t = instance.t.bind(instance) as (key: string) => string;

const ProductIcon = () => <svg data-testid="product-icon" />;
const appTheme = extendTheme({ ...getThemeConfig() });

const renderAt = (url: string, mode: 'signIn' | 'signUp' = 'signIn') => {
  window.history.replaceState(null, '', url);
  return render(
    <CssVarsProvider theme={appTheme}>
      <RedirectProductHint mode={mode} />
    </CssVarsProvider>
  );
};

describe('RedirectProductHint', () => {
  afterEach(() => {
    nav.items = [];
    window.history.replaceState(null, '', '/');
  });

  it('names the product a redirectTo leads into, with its icon hidden from assistive tech', () => {
    nav.items = [{ path: '/product', label: 'Product', icon: ProductIcon }];
    renderAt('/login?redirectTo=%2Fproduct%2Frun%2F42%3Ftab%3Dreport');
    const hint = screen.getByTestId('auth-redirect-product-hint');
    expect(hint).toHaveTextContent('Sign in to continue to Product');
    expect(screen.getByTestId('product-icon').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('uses the sign-up wording on the registration page', () => {
    nav.items = [{ path: '/product', label: 'Product' }];
    renderAt('/register?redirectTo=%2Fproduct', 'signUp');
    expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(
      'Create an account to continue to Product'
    );
  });

  it('shows a label with HTML-special characters as written', () => {
    nav.items = [{ path: '/product', label: `R&D <Studio> "Q's"` }];
    renderAt('/login?redirectTo=%2Fproduct');
    expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(
      `Sign in to continue to R&D <Studio> "Q's"`
    );
  });

  it('renders without an icon when the item has none', () => {
    nav.items = [{ path: '/product', label: 'Product' }];
    renderAt('/login?redirectTo=%2Fproduct');
    expect(screen.getByTestId('auth-redirect-product-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('product-icon')).toBeNull();
  });

  it.each([
    ['no redirectTo', '/login'],
    ['a core route', '/login?redirectTo=%2Fnew'],
    ['a look-alike path', '/login?redirectTo=%2Fproductivity'],
    ['an off-site redirect', '/login?redirectTo=%2F%2Fevil.test%2Fproduct'],
  ])('renders nothing for %s', (_, url) => {
    nav.items = [{ path: '/product', label: 'Product' }];
    renderAt(url);
    expect(screen.queryByTestId('auth-redirect-product-hint')).toBeNull();
  });

  it('renders nothing when no premium nav items are registered', () => {
    renderAt('/login?redirectTo=%2Fproduct');
    expect(screen.queryByTestId('auth-redirect-product-hint')).toBeNull();
  });
});
