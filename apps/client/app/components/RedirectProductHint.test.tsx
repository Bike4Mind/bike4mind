import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PremiumNavDescriptor } from '@client/app/premiumContract';
import i18next from 'i18next';
import en from '@client/app/locales/en.json';
import RedirectProductHint, { useRedirectProduct } from './RedirectProductHint';

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

// Wired the way MultiStepLogin and Register wire it, so the URL checks in useRedirectProduct are exercised.
function Harness({ mode }: { mode: 'signIn' | 'signUp' }) {
  const item = useRedirectProduct();
  return <RedirectProductHint mode={mode} item={item} />;
}

const renderAt = (url: string, mode: 'signIn' | 'signUp' = 'signIn') => {
  window.history.replaceState(null, '', url);
  return render(
    <CssVarsProvider theme={appTheme}>
      <Harness mode={mode} />
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

  describe('when the item names the site the redirect carries', () => {
    // Stands in for the overlay's check: a short dotted host, else null.
    const redirectTargetName = (params: URLSearchParams) => {
      const url = params.get('url');
      return url && url.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url) ? url : null;
    };
    const item = { path: '/product', label: 'Product', redirectTargetName };

    it('names the site on the sign-in page', () => {
      nav.items = [item];
      renderAt('/login?redirectTo=%2Fproduct%3Furl%3Dexample.com');
      expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(
        /^Sign in and Product reads example\.com$/
      );
    });

    it('names the site on the registration page', () => {
      nav.items = [item];
      renderAt('/register?redirectTo=%2Fproduct%3Furl%3Dexample.com', 'signUp');
      expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(
        /^Create an account and Product reads example\.com$/
      );
    });

    it('keeps the plain line with no url', () => {
      nav.items = [item];
      renderAt('/login?redirectTo=%2Fproduct');
      expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(/^Sign in to continue to Product$/);
    });

    it.each([
      ['a script tag', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
      ['a private address', '10.0.0.1%3A6379'],
      ['an over-long value', `${'a'.repeat(2100)}.com`],
    ])('falls back to the plain line, rendering nothing of %s', (_, value) => {
      nav.items = [item];
      renderAt(`/login?redirectTo=%2Fproduct%3Furl%3D${value}`);
      const hint = screen.getByTestId('auth-redirect-product-hint');
      expect(hint).toHaveTextContent(/^Sign in to continue to Product$/);
      expect(hint.querySelector('script, a')).toBeNull();
    });

    it('renders the site as text, not a link or markup', () => {
      nav.items = [{ ...item, redirectTargetName: () => '<b>x</b>.com' }];
      renderAt('/login?redirectTo=%2Fproduct%3Furl%3Dx.com');
      const hint = screen.getByTestId('auth-redirect-product-hint');
      expect(hint).toHaveTextContent('Sign in and Product reads <b>x</b>.com');
      expect(hint.querySelector('b, a')).toBeNull();
    });

    it('falls back when the callback throws', () => {
      nav.items = [
        {
          ...item,
          redirectTargetName: () => {
            throw new Error('boom');
          },
        },
      ];
      renderAt('/login?redirectTo=%2Fproduct%3Furl%3Dexample.com');
      expect(screen.getByTestId('auth-redirect-product-hint')).toHaveTextContent(/^Sign in to continue to Product$/);
    });
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
