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

describe('PaymentModal', () => {
  it('scrolls inside the dialog so the form stays reachable in a short window', () => {
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

    const dialog = screen.getByTestId('payment-modal-dialog');
    expect(getComputedStyle(dialog).overflowY).toBe('auto');
    expect(dialog).toContainElement(screen.getByTestId('checkout-form-pay-btn'));
  });
});
