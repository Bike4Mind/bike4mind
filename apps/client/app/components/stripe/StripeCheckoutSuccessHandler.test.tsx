import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';

const { mockToastSuccess, mockGet, mockTrackPurchaseConversion, mockBootstrapSession, tokenState, userState } =
  vi.hoisted(() => ({
    mockToastSuccess: vi.fn(),
    mockGet: vi.fn(),
    mockTrackPurchaseConversion: vi.fn(),
    mockBootstrapSession: vi.fn(),
    tokenState: { accessToken: 'token' as string | null },
    userState: { currentUser: { id: 'buyer' } },
  }));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: { getState: () => userState } }));
vi.mock('@client/app/utils/purchaseConversion', () => ({ trackPurchaseConversion: mockTrackPurchaseConversion }));
vi.mock('@client/app/utils/sessionBootstrap', () => ({ bootstrapSession: mockBootstrapSession }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: { getState: () => tokenState } }));

import { consumeBillingCheckoutReturn } from '@client/app/utils/billingCheckoutReturn';
import StripeCheckoutSuccessHandler, {
  CHECKOUT_RETURN_DELAY_MS,
  checkoutConfirmation,
  checkoutReturnNavigator,
} from './StripeCheckoutSuccessHandler';

const SUMMARY = {
  transactionId: 'cs_test_1',
  value: 30,
  currency: 'USD',
  priceId: 'price_pro',
  planName: 'Professional',
  quantity: 1,
  credits: 50000,
};

const GENERIC = 'Subscription completed successfully!';

/** Lets every pending promise chain run, not just the next microtask. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const CHECKOUT_RETURN = '?subscription_success=true&checkout_session_id=cs_test_1';

function returnTo(search: string) {
  window.history.replaceState({}, '', `/${search}`);
  return render(<StripeCheckoutSuccessHandler />);
}

describe('StripeCheckoutSuccessHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    consumeBillingCheckoutReturn();
    tokenState.accessToken = 'token';
    userState.currentUser = { id: 'buyer' };
    mockBootstrapSession.mockResolvedValue(undefined);
    mockGet.mockResolvedValue({ data: SUMMARY });
  });

  it('marks the return when it lands on an open Billing modal', () => {
    returnTo('?billing=plans&subscription_success=true');

    expect(consumeBillingCheckoutReturn()).toBe(true);
  });

  it('does not mark an ordinary subscription return', () => {
    returnTo('?subscription_success=true');

    expect(consumeBillingCheckoutReturn()).toBe(false);
  });

  it('does not mark a billing URL that is not a Stripe return', () => {
    returnTo('?billing=plans');

    expect(consumeBillingCheckoutReturn()).toBe(false);
  });

  it('confirms at once but waits for the cold-load session bootstrap before the lookup', async () => {
    let finishBootstrap!: () => void;
    mockBootstrapSession.mockReturnValue(new Promise<void>(resolve => (finishBootstrap = resolve)));
    returnTo(CHECKOUT_RETURN);

    expect(mockToastSuccess).toHaveBeenCalledExactlyOnceWith(GENERIC, { id: 'cs_test_1' });
    await settle();
    expect(mockGet).not.toHaveBeenCalled();

    finishBootstrap();
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledExactlyOnceWith('/api/subscriptions/checkout-session', {
        params: { id: 'cs_test_1' },
      })
    );
  });

  it('upgrades the confirmation with the plan and credits, and reports the conversion', async () => {
    returnTo(CHECKOUT_RETURN);

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenLastCalledWith("You're on Professional - 50,000 credits included", {
        id: 'cs_test_1',
      })
    );
    expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith(SUMMARY);
    expect(window.location.search).toBe('');
  });

  it('confirms again but reports once when the return URL is loaded again', async () => {
    returnTo(CHECKOUT_RETURN).unmount();
    await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());

    returnTo(CHECKOUT_RETURN);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    await settle();
    expect(mockToastSuccess).toHaveBeenCalledTimes(4);
    expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce();
  });

  it('skips the lookup and keeps the generic confirmation when no session was restored', async () => {
    tokenState.accessToken = null;
    returnTo(CHECKOUT_RETURN);

    await settle();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledExactlyOnceWith(GENERIC, { id: 'cs_test_1' });
    expect(window.sessionStorage.getItem('b4m-reported-checkout-sessions')).toBe('[]');
  });

  it('keeps the generic confirmation and releases the claim when the lookup fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('400'));
    returnTo(CHECKOUT_RETURN);

    await waitFor(() => expect(window.sessionStorage.getItem('b4m-reported-checkout-sessions')).toBe('[]'));
    expect(mockToastSuccess).toHaveBeenCalledExactlyOnceWith(GENERIC, { id: 'cs_test_1' });
    expect(mockTrackPurchaseConversion).not.toHaveBeenCalled();
  });

  it('confirms an admin-initiated conversion without a lookup', () => {
    returnTo('?subscription_success=true');

    expect(mockToastSuccess).toHaveBeenCalledExactlyOnceWith(GENERIC);
    expect(mockBootstrapSession).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('opens the newly created team after verified checkout', async () => {
    const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
    try {
      mockGet.mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true, organizationId: 'org1' } });
      returnTo(CHECKOUT_RETURN);
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/organizations/org1?team_created=true'));
      expect(mockToastSuccess).toHaveBeenLastCalledWith('Team created successfully!', { id: 'cs_test_1' });
    } finally {
      replace.mockRestore();
    }
  });

  it('keeps same-page team navigation and one conversion across StrictMode effect replay', async () => {
    const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
    try {
      mockGet.mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true, organizationId: 'org1' } });
      window.history.replaceState({}, '', `/${CHECKOUT_RETURN}`);
      render(
        <StrictMode>
          <StripeCheckoutSuccessHandler />
        </StrictMode>
      );
      await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith('/organizations/org1?team_created=true'));
      expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith({
        ...SUMMARY,
        teamCheckout: true,
        organizationId: 'org1',
      });
      expect(window.location.search).toBe('');
    } finally {
      replace.mockRestore();
    }
  });

  it('waits for team provisioning without reporting the purchase twice', async () => {
    const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGet
        .mockResolvedValueOnce({ data: { ...SUMMARY, teamCheckout: true } })
        .mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true, organizationId: 'org1' } });
      returnTo(CHECKOUT_RETURN);
      await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(replace).toHaveBeenCalledWith('/organizations/org1?team_created=true');
      expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      replace.mockRestore();
    }
  });

  it.each(['navigation', 'unmount', 'account switch'])(
    'does not redirect after %s during a held provisioning lookup',
    async change => {
      const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let resolveLookup!: (response: {
          data: typeof SUMMARY & { teamCheckout: boolean; organizationId: string };
        }) => void;
        mockGet.mockResolvedValueOnce({ data: { ...SUMMARY, teamCheckout: true } }).mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveLookup = resolve;
            })
        );
        const view = returnTo(CHECKOUT_RETURN);
        await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(1500);
        expect(mockGet).toHaveBeenCalledTimes(2);
        if (change === 'navigation') window.history.pushState({}, '', '/notebooks/draft');
        if (change === 'unmount') view.unmount();
        if (change === 'account switch') userState.currentUser = { id: 'other-buyer' };
        resolveLookup({ data: { ...SUMMARY, teamCheckout: true, organizationId: 'org1' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(replace).not.toHaveBeenCalled();
        expect(mockTrackPurchaseConversion).toHaveBeenCalledExactlyOnceWith({ ...SUMMARY, teamCheckout: true });
        await vi.advanceTimersByTimeAsync(10000);
        expect(mockGet).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
        replace.mockRestore();
      }
    }
  );

  it('retries provisioning once from the current page even if Check again is clicked twice', async () => {
    const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGet.mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true } });
      returnTo(CHECKOUT_RETURN);
      await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(9000);
      const options = mockToastSuccess.mock.lastCall?.[1] as { action: { onClick: () => void } };
      mockGet.mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true, organizationId: 'org1' } });
      options.action.onClick();
      options.action.onClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(8);
      expect(replace).toHaveBeenCalledExactlyOnceWith('/organizations/org1?team_created=true');
      expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      replace.mockRestore();
    }
  });

  it('does not revive an obsolete check-again action after leaving the return page', async () => {
    const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGet.mockResolvedValue({ data: { ...SUMMARY, teamCheckout: true } });
      returnTo(CHECKOUT_RETURN);
      await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(9000);
      const options = mockToastSuccess.mock.lastCall?.[1] as { action: { onClick: () => void } };
      expect(options.action).toBeDefined();
      window.history.pushState({}, '', '/notebooks/draft');
      options.action.onClick();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockGet).toHaveBeenCalledTimes(7);
      expect(replace).not.toHaveBeenCalled();
      expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      replace.mockRestore();
    }
  });
});

describe('checkoutConfirmation', () => {
  it('names the plan without credits when the allotment is unknown', () => {
    expect(checkoutConfirmation({ planName: 'Team' })).toBe("You're on Team");
  });

  it('falls back to the generic message without a plan name', () => {
    expect(checkoutConfirmation({ credits: 100 })).toBe('Subscription completed successfully!');
  });

  describe('a checkout another Bike4Mind app started', () => {
    const PAINTBOX = 'https://paintbox.bike4mind.com/';
    const back = `checkout_return_to=${encodeURIComponent(PAINTBOX)}`;

    beforeEach(() => {
      vi.clearAllMocks();
      window.sessionStorage.clear();
      tokenState.accessToken = 'token';
      userState.currentUser = { id: 'buyer' };
      mockBootstrapSession.mockResolvedValue(undefined);
      mockGet.mockResolvedValue({ data: SUMMARY });
    });

    it('returns there only after the purchase is confirmed and reported', async () => {
      const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        returnTo(`?${back}&subscription_success=true&checkout_session_id=cs_test_1`);
        await waitFor(() => expect(mockTrackPurchaseConversion).toHaveBeenCalledOnce());
        expect(replace).not.toHaveBeenCalled();
        expect(window.location.search).toBe('');
        await vi.advanceTimersByTimeAsync(CHECKOUT_RETURN_DELAY_MS);
        expect(replace).toHaveBeenCalledExactlyOnceWith(PAINTBOX);
      } finally {
        vi.useRealTimers();
        replace.mockRestore();
      }
    });

    it('returns there at once from a cancelled checkout', () => {
      const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
      returnTo(`?${back}`);
      expect(replace).toHaveBeenCalledExactlyOnceWith(PAINTBOX);
      expect(mockToastSuccess).not.toHaveBeenCalled();
      replace.mockRestore();
    });

    it('never follows a return target it does not allow', async () => {
      const replace = vi.spyOn(checkoutReturnNavigator, 'replace').mockImplementation(() => undefined);
      for (const target of ['https://evil.example/', 'http://paintbox.bike4mind.com/', 'javascript:alert(1)']) {
        returnTo(`?checkout_return_to=${encodeURIComponent(target)}`);
        returnTo(`?checkout_return_to=${encodeURIComponent(target)}&subscription_success=true`);
      }
      await settle();
      expect(replace).not.toHaveBeenCalled();
      replace.mockRestore();
    });
  });
});
