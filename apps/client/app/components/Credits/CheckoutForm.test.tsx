import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import CheckoutForm from './CheckoutForm';

const confirmPayment = vi.fn();
const retrievePaymentIntent = vi.fn();
const reportCreditPurchaseConversion = vi.fn();

vi.mock('@client/app/components/stripe/StripePaymentReturnHandler', () => ({
  reportCreditPurchaseConversion: (id: string) => reportCreditPurchaseConversion(id),
}));

// Stable identities, as the real hooks return, so the status effect does not re-run every render.
const stripeMock = { confirmPayment, retrievePaymentIntent };
const elementsMock = {};
vi.mock('@stripe/react-stripe-js', () => ({
  PaymentElement: () => null,
  useStripe: () => stripeMock,
  useElements: () => elementsMock,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Callers pass an inline onPayment, so each render hands the form a new function identity.
const formElement = (onPayment: () => void, onConfirmResult: () => void, onPaymentPending = vi.fn()) => (
  <TestWrapper>
    <CheckoutForm
      clientSecret="pi_1_secret_x"
      onPayment={() => onPayment()}
      onConfirmResult={onConfirmResult}
      onPaymentPending={onPaymentPending}
    />
  </TestWrapper>
);

const renderForm = (onPayment = vi.fn(), onConfirmResult = vi.fn(), onPaymentPending = vi.fn()) => {
  const utils = render(formElement(onPayment, onConfirmResult, onPaymentPending));
  return { ...utils, onPayment, onConfirmResult, onPaymentPending };
};

describe('CheckoutForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'requires_payment_method' } });
  });

  it('confirms in-page and reports a success once', async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } });
    const { onPayment, onConfirmResult, onPaymentPending, rerender } = renderForm();

    await userEvent.click(screen.getByTestId('checkout-submit-btn'));

    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'if_required' }));
    await waitFor(() => expect(onConfirmResult).toHaveBeenCalledWith({ outcome: 'succeeded' }));
    expect(onPayment).toHaveBeenCalledTimes(1);

    // The status effect re-runs on a parent re-render and now sees the intent as succeeded.
    retrievePaymentIntent.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    const retrievesBefore = retrievePaymentIntent.mock.calls.length;
    rerender(formElement(onPayment, onConfirmResult, onPaymentPending));
    await waitFor(() => expect(retrievePaymentIntent.mock.calls.length).toBeGreaterThan(retrievesBefore));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onPayment).toHaveBeenCalledTimes(1);
    // An in-page success never reaches StripePaymentReturnHandler, so the form reports the conversion.
    expect(reportCreditPurchaseConversion).toHaveBeenCalledExactlyOnceWith('pi_1');
  });

  it('locks the pay button once the payment succeeds so a second confirm cannot overwrite the result', async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    renderForm();

    await userEvent.click(screen.getByTestId('checkout-submit-btn'));

    await waitFor(() => expect(screen.getByTestId('checkout-submit-btn')).toHaveProperty('disabled', true));
    expect(screen.getByText('Payment succeeded!')).toBeTruthy();
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it('reports the Stripe error codes but never the error message', async () => {
    confirmPayment.mockResolvedValue({
      error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Declined' },
    });
    const { onPayment, onConfirmResult } = renderForm();

    await userEvent.click(screen.getByTestId('checkout-submit-btn'));

    await waitFor(() =>
      expect(onConfirmResult).toHaveBeenCalledWith({
        outcome: 'error',
        errorType: 'card_error',
        errorCode: 'card_declined',
        declineCode: 'insufficient_funds',
      })
    );
    expect(onPayment).not.toHaveBeenCalled();
    expect(await screen.findByText('Declined')).toBeTruthy();
  });

  it('reports a processing payment without announcing success', async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'processing' } });
    const { onPayment, onConfirmResult } = renderForm();

    await userEvent.click(screen.getByTestId('checkout-submit-btn'));

    await waitFor(() => expect(onConfirmResult).toHaveBeenCalledWith({ outcome: 'processing' }));
    expect(onPayment).not.toHaveBeenCalled();
  });

  it.each(['processing', 'requires_action'])('notifies pending when confirming a %s intent', async status => {
    confirmPayment.mockResolvedValue({ paymentIntent: { status } });
    const { onPayment, onPaymentPending } = renderForm();
    await userEvent.click(screen.getByTestId('checkout-submit-btn'));
    await waitFor(() => expect(onPaymentPending).toHaveBeenCalledTimes(1));
    expect(onPayment).not.toHaveBeenCalled();
  });

  it.each(['processing', 'requires_action'])('notifies pending when retrieving a %s intent', async status => {
    retrievePaymentIntent.mockResolvedValue({ paymentIntent: { status } });
    const { onPayment, onConfirmResult, onPaymentPending, rerender } = renderForm();
    await waitFor(() => expect(onPaymentPending).toHaveBeenCalledTimes(1));
    rerender(formElement(onPayment, onConfirmResult, onPaymentPending));
    await waitFor(() => expect(retrievePaymentIntent).toHaveBeenCalledTimes(2));
    expect(onPaymentPending).toHaveBeenCalledTimes(1);
    expect(onPayment).not.toHaveBeenCalled();
  });

  it('shows a requires_action confirm as pending, not as a failure', async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'requires_action' } });
    const { onPayment, onConfirmResult } = renderForm();

    await userEvent.click(screen.getByTestId('checkout-submit-btn'));

    await waitFor(() => expect(onConfirmResult).toHaveBeenCalledWith({ outcome: 'requires_action' }));
    expect(await screen.findByText(/needs one more step/)).toBeTruthy();
    expect(screen.queryByText('Something went wrong.')).toBeNull();
    expect(screen.getByTestId('checkout-submit-btn')).toHaveProperty('disabled', true);
    expect(onPayment).not.toHaveBeenCalled();
    expect(reportCreditPurchaseConversion).not.toHaveBeenCalled();
  });

  describe('3-D Secure authentication failure', () => {
    it('shows an actionable message when the confirm error is an authentication failure', async () => {
      confirmPayment.mockResolvedValue({
        error: {
          type: 'invalid_request_error',
          code: 'payment_intent_authentication_failure',
          message: 'We are unable to authenticate your payment method.',
        },
      });
      const { onPayment, onConfirmResult } = renderForm();

      await userEvent.click(screen.getByTestId('checkout-submit-btn'));

      await waitFor(() =>
        expect(onConfirmResult).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'error', errorCode: 'payment_intent_authentication_failure' })
        )
      );
      const message = await screen.findByTestId('checkout-payment-message');
      expect(message.textContent).toMatch(/could not verify your card/);
      expect(message.textContent).toMatch(/use a different card/);
      expect(screen.getByTestId('checkout-submit-btn')).toHaveProperty('disabled', false);
      expect(onPayment).not.toHaveBeenCalled();
    });

    it('shows the actionable message when the confirm returns the intent to requires_payment_method', async () => {
      confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'requires_payment_method' } });
      const { onPayment } = renderForm();

      await userEvent.click(screen.getByTestId('checkout-submit-btn'));

      const message = await screen.findByTestId('checkout-payment-message');
      expect(message.textContent).toMatch(/could not verify your card/);
      expect(screen.getByTestId('checkout-submit-btn')).toHaveProperty('disabled', false);
      expect(onPayment).not.toHaveBeenCalled();
    });

    it('shows the actionable message when returning from a failed redirect challenge', async () => {
      retrievePaymentIntent.mockResolvedValue({
        paymentIntent: {
          status: 'requires_payment_method',
          last_payment_error: { code: 'payment_intent_authentication_failure' },
        },
      });
      renderForm();

      const message = await screen.findByTestId('checkout-payment-message');
      expect(message.textContent).toMatch(/could not verify your card/);
    });

    it('keeps the generic fallback for unknown errors', async () => {
      confirmPayment.mockResolvedValue({ error: { type: 'api_error', code: 'something_else', message: 'boom' } });
      renderForm();

      await userEvent.click(screen.getByTestId('checkout-submit-btn'));

      const message = await screen.findByTestId('checkout-payment-message');
      expect(message.textContent).toBe('An unexpected error occurred.');
    });
  });
});
