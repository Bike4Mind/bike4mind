import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PaymentModal from './PaymentModal';

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./CheckoutForm', () => ({
  default: () => <button data-testid="checkout-form-pay-btn">Pay now</button>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

// jsdom does not apply the @media rules emotion emits for a breakpoint object, so the dialog's
// responsive sx values never reach getComputedStyle. Read the rules emotion emitted for xs instead.
const phoneRules = () => {
  const classNames = [...screen.getByTestId('payment-modal-dialog').classList];
  const emitted = [...document.querySelectorAll('style')].map(style => style.textContent ?? '').join('\n');
  return emitted
    .split('}')
    .filter(rule => rule.includes('@media (min-width:0px)') && classNames.some(name => rule.includes(`.${name}`)));
};

const declares = (rules: string[], declaration: string) =>
  rules.some(rule => rule.includes(`{${declaration}`) || rule.includes(`;${declaration}`));

describe('PaymentModal', () => {
  const renderModal = () =>
    render(
      <CssVarsProvider theme={appTheme}>
        <PaymentModal
          isOpen
          onClose={vi.fn()}
          stripePromise={Promise.resolve(null)}
          clientSecret="pi_test_secret"
          productName="33,333 Credits Package"
          onPayment={vi.fn()}
        />
      </CssVarsProvider>
    );

  it('scrolls inside the dialog so the form stays reachable in a short window', () => {
    renderModal();

    const dialog = screen.getByTestId('payment-modal-dialog');
    expect(getComputedStyle(dialog).overflowY).toBe('auto');
    expect(dialog).toContainElement(screen.getByTestId('checkout-form-pay-btn'));
  });

  it('never forces the dialog wider than a phone screen', () => {
    renderModal();

    const rules = phoneRules();
    expect(declares(rules, 'min-width:auto')).toBe(true);
    expect(declares(rules, 'max-width:calc(100vw - 32px)')).toBe(true);
  });

  it('fills the phone width instead of shrinking to the card form', () => {
    renderModal();

    expect(declares(phoneRules(), 'width:calc(100vw - 32px)')).toBe(true);
  });
});
