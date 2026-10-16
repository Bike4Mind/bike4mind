import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { CreditPurchaseEvents } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CreditPackageId, TransactionType } from '@client/lib/credits/types';
import type { ConfirmResult } from './CheckoutForm';
import PaymentButton from './PaymentButton';

const apiPost = vi.fn();
const logEvent = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}));
vi.mock('@client/app/hooks/data/analytics', () => ({
  useLogEvent: () => ({ mutate: logEvent }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => 0.01,
}));
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: () => Promise.resolve(null),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// The modal stands in for Stripe: it exposes the confirm-result and close callbacks as buttons.
let confirmResult: ConfirmResult = { outcome: 'succeeded' };
vi.mock('./PaymentModal', () => ({
  default: ({
    isOpen,
    onClose,
    onConfirmResult,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onConfirmResult: (result: ConfirmResult) => void;
  }) =>
    isOpen ? (
      <div>
        <button data-testid="payment-modal-confirm-btn" onClick={() => onConfirmResult(confirmResult)} />
        <button data-testid="payment-modal-close-btn" onClick={onClose} />
      </div>
    ) : null,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderButton = () =>
  render(
    <TestWrapper>
      <PaymentButton transactionType={TransactionType.Package} packageId={CreditPackageId.A} onPayment={vi.fn()} />
    </TestWrapper>
  );

const loggedTypes = () => logEvent.mock.calls.map(([event]) => event.type);

describe('PaymentButton funnel events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmResult = { outcome: 'succeeded' };
    apiPost.mockResolvedValue({
      data: { clientSecret: 'pi_1_secret_x', publishableKey: 'pk_test', paymentIntentId: 'pi_1' },
    });
  });

  it('records the request, the opened form and the confirm result against the intent', async () => {
    renderButton();

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    await userEvent.click(await screen.findByTestId('payment-modal-confirm-btn'));
    await userEvent.click(screen.getByTestId('payment-modal-close-btn'));

    expect(logEvent).toHaveBeenCalledWith({
      type: CreditPurchaseEvents.CHECKOUT_REQUESTED,
      metadata: { transactionType: TransactionType.Package, packageId: CreditPackageId.A },
    });
    expect(logEvent).toHaveBeenCalledWith({
      type: CreditPurchaseEvents.PAYMENT_FORM_OPENED,
      metadata: { paymentIntentId: 'pi_1' },
    });
    expect(logEvent).toHaveBeenCalledWith({
      type: CreditPurchaseEvents.PAYMENT_CONFIRM_RESULT,
      metadata: { paymentIntentId: 'pi_1', outcome: 'succeeded' },
    });
    // A paid checkout closing is not an abandonment.
    expect(loggedTypes()).not.toContain(CreditPurchaseEvents.PAYMENT_ABANDONED);
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain('pi_1_secret_x');
  });

  it('records an abandonment with the last failed outcome when the form is closed', async () => {
    confirmResult = { outcome: 'error', errorType: 'card_error', errorCode: 'card_declined' };
    renderButton();

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    await userEvent.click(await screen.findByTestId('payment-modal-confirm-btn'));
    await userEvent.click(screen.getByTestId('payment-modal-close-btn'));

    expect(logEvent).toHaveBeenCalledWith({
      type: CreditPurchaseEvents.PAYMENT_ABANDONED,
      metadata: { paymentIntentId: 'pi_1', lastOutcome: 'error' },
    });
  });

  it('does not record an abandonment when the payment is waiting on a customer action', async () => {
    confirmResult = { outcome: 'requires_action' };
    renderButton();

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    await userEvent.click(await screen.findByTestId('payment-modal-confirm-btn'));
    await userEvent.click(screen.getByTestId('payment-modal-close-btn'));

    expect(loggedTypes()).toContain(CreditPurchaseEvents.PAYMENT_CONFIRM_RESULT);
    expect(loggedTypes()).not.toContain(CreditPurchaseEvents.PAYMENT_ABANDONED);
  });

  it('records a failed start with its HTTP status', async () => {
    apiPost.mockRejectedValue(
      new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
    );
    renderButton();

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));

    await waitFor(() =>
      expect(logEvent).toHaveBeenCalledWith({
        type: CreditPurchaseEvents.CHECKOUT_START_FAILED,
        metadata: { transactionType: TransactionType.Package, httpStatus: 403 },
      })
    );
    expect(loggedTypes()).not.toContain(CreditPurchaseEvents.PAYMENT_FORM_OPENED);
  });
});

describe('PaymentButton start-payment requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts start-payment once per click even when the parent re-renders while it is pending', async () => {
    let resolveStart: (value: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise(resolve => (resolveStart = resolve)));
    const ui = () => (
      <TestWrapper>
        <PaymentButton transactionType={TransactionType.Package} packageId={CreditPackageId.A} onPayment={vi.fn()} />
      </TestWrapper>
    );
    const { rerender } = render(ui());

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    // Each rerender hands PaymentButton a fresh props object, which used to re-run the start effect.
    rerender(ui());
    rerender(ui());
    rerender(ui());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolveStart({ data: { clientSecret: 'pi_1_secret_x', publishableKey: 'pk_test', paymentIntentId: 'pi_1' } });
    await screen.findByTestId('payment-modal-confirm-btn');
    rerender(ui());

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith({
      type: CreditPurchaseEvents.PAYMENT_FORM_OPENED,
      metadata: { paymentIntentId: 'pi_1' },
    });
  });

  it('starts a fresh request on the next click after the form is closed', async () => {
    apiPost.mockResolvedValue({
      data: { clientSecret: 'pi_1_secret_x', publishableKey: 'pk_test', paymentIntentId: 'pi_1' },
    });
    renderButton();

    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    await userEvent.click(await screen.findByTestId('payment-modal-close-btn'));
    await userEvent.click(screen.getByTestId('credits-purchase-btn'));
    await screen.findByTestId('payment-modal-confirm-btn');

    expect(apiPost).toHaveBeenCalledTimes(2);
  });
});
