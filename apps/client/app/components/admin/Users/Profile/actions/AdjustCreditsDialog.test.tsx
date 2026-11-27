import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';
import { AdjustCreditsDialog } from './AdjustCreditsDialog';
import { LiveProfile, ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ update: vi.fn(), recentGrants: vi.fn(), refetch: vi.fn() }));

vi.mock('./useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));
vi.mock('@client/app/hooks/data/adminUserCredits', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/adminUserCredits')>()),
  useAdminRecentCreditGrants: mocks.recentGrants,
}));

const MINUS = '\u2212';
const user = buildProfile({ currentCredits: 500 });

const setup = (onAudit?: () => void) => {
  const onClose = vi.fn();
  render(<AdjustCreditsDialog user={user} onClose={onClose} onAudit={onAudit} />, { wrapper: ProfileTestWrapper });
  return { onClose };
};

const typeAmount = (value: string) =>
  fireEvent.change(screen.getByTestId('adjust-credits-amount-input'), { target: { value } });
const pickReason = () => fireEvent.click(screen.getByTestId('adjust-credits-dialog-reason-input-preset-0'));
const confirmButton = () => screen.getByTestId('adjust-credits-dialog-confirm-btn');
const secondaryButton = () => screen.queryByTestId('adjust-credits-dialog-secondary-btn');
const grantLimitRefusal = () =>
  new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 403,
    data: {
      code: 'admin_grant_limit',
      subject: 'user',
      reason: 'confirmation_required',
      receivedCredits: 90_000,
      remainingCredits: 10_000,
      error: 'Over the limit',
    },
  } as AxiosResponse);
const figures = (receivedCredits: number, immediateLimit = 100_000) => ({
  isLoading: false,
  data: { receivedCredits, immediateLimit, grants: [] },
  refetch: mocks.refetch,
});

describe('AdjustCreditsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({ appliedCreditDelta: 300, currentCredits: 800 });
    mocks.recentGrants.mockReturnValue(figures(0));
  });

  describe('recent admin grants', () => {
    const recent = (suffix = '') => screen.getByTestId(`adjust-credits-recent-grants${suffix}`);

    it('says so when the user received no admin grants in the last 24 hours', () => {
      setup();
      expect(recent('-empty')).toHaveTextContent('No admin grants in the last 24 hours.');
      expect(mocks.recentGrants).toHaveBeenCalledWith(user.id);
    });

    it('lists the last grants newest first with their value and admin, and no window total', () => {
      mocks.recentGrants.mockReturnValue({
        isLoading: false,
        data: {
          receivedCredits: 102_500,
          immediateLimit: 100_000,
          grants: [
            { at: '2026-06-15T11:05:00.000Z', credits: 100_000, grantedBy: 'Grace Hopper' },
            { at: '2026-06-15T09:30:00.000Z', credits: 2_500, grantedBy: 'ops@example.com' },
          ],
        },
      });
      setup();

      expect(screen.queryByTestId('adjust-credits-recent-grants-total')).not.toBeInTheDocument();
      expect(recent('-row-0')).toHaveTextContent('15 Jun 2026, 11:05 UTC: +100,000 credits ($60) by Grace Hopper');
      expect(recent('-row-1')).toHaveTextContent('15 Jun 2026, 09:30 UTC: +2,500 credits ($1.50) by ops@example.com');
      expect(screen.queryByTestId('adjust-credits-recent-grants-row-2')).not.toBeInTheDocument();
    });

    it('says when the recent grants could not be loaded', () => {
      mocks.recentGrants.mockReturnValue({ isLoading: false, data: undefined });
      setup();
      expect(recent('-error')).toHaveTextContent('Recent grants could not be loaded.');
    });
  });

  it('opens in Set-to mode previewing the current balance', () => {
    setup();

    expect(screen.getByTestId('adjust-credits-mode-set')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('adjust-credits-preview-before')).toHaveTextContent('500');
  });

  it('previews Set to, Add and Subtract with before, after and delta', () => {
    setup();

    typeAmount('800');
    expect(screen.getByTestId('adjust-credits-preview-after')).toHaveTextContent('800');
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent('+300');

    fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
    typeAmount('100');
    expect(screen.getByTestId('adjust-credits-preview-before')).toHaveTextContent('500');
    expect(screen.getByTestId('adjust-credits-preview-after')).toHaveTextContent('600');
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent('+100');

    fireEvent.click(screen.getByTestId('adjust-credits-mode-subtract'));
    typeAmount('120');
    expect(screen.getByTestId('adjust-credits-preview-after')).toHaveTextContent('380');
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent(`${MINUS}120`);
  });

  it('never previews a subtraction below zero', () => {
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-subtract'));

    typeAmount('9000');

    expect(screen.getByTestId('adjust-credits-preview-after')).toHaveTextContent('0');
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent(`${MINUS}500`);
  });

  it('accepts 0 as a Set-to target and sends it as an absolute currentCredits', async () => {
    setup();

    expect(screen.getByTestId('adjust-credits-amount-input')).toHaveValue('0');
    expect(confirmButton()).toBeDisabled();
    pickReason();
    expect(confirmButton()).toBeEnabled();
    expect(confirmButton()).toHaveTextContent('Set balance to 0');
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ currentCredits: 0, creditReason: 'Goodwill credit' })
    );
  });

  it('sends Add as a positive creditDelta', async () => {
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
    typeAmount('250');
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ creditDelta: 250, creditReason: 'Goodwill credit' })
    );
  });

  it('sends Subtract as a negative creditDelta', async () => {
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-subtract'));
    typeAmount('75');
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ creditDelta: -75, creditReason: 'Goodwill credit' })
    );
  });

  it.each(['abc', '1.5', '-3', ''])('blocks the amount "%s" with the amount hint', value => {
    setup();
    pickReason();

    typeAmount(value);

    expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent(
      'Enter a whole number of credits, 0 or more.'
    );
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('adjust-credits-preview-after')).toHaveTextContent('-');
  });

  it('blocks a change that leaves the balance as it is', () => {
    setup();
    pickReason();

    typeAmount('500');

    expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent('The balance is already 500.');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent('No change');
  });

  it('starts a Set-to at the current balance when switching back, and blocks it as no change', () => {
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
    fireEvent.click(screen.getByTestId('adjust-credits-mode-set'));

    expect(screen.getByTestId('adjust-credits-amount-input')).toHaveValue('500');
    expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent('The balance is already 500.');
  });

  it('keeps confirm blocked until a reason is complete, even with a valid amount', () => {
    setup();
    typeAmount('100');

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent(
      'Pick a reason or write at least 5 characters.'
    );
    fireEvent.change(screen.getByTestId('adjust-credits-dialog-reason-input'), { target: { value: 'abc' } });
    expect(confirmButton()).toBeDisabled();
    fireEvent.change(screen.getByTestId('adjust-credits-dialog-reason-input'), { target: { value: 'invoice 42' } });
    expect(confirmButton()).toBeEnabled();
  });

  it('closes, shows the undo toast and undoes with the opposite creditDelta', async () => {
    const onAudit = vi.fn();
    const { onClose } = setup(onAudit);
    typeAmount('800');
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Balance set to 800 (+300)');
    mocks.update.mockClear();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ creditDelta: -300, creditReason: 'Undo: Goodwill credit' })
    );
    await waitFor(() => expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('adjust-credits-dialog-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('undoes only the committed delta when a concurrent balance change clamps a deduction', async () => {
    mocks.update.mockResolvedValueOnce({ appliedCreditDelta: -40, currentCredits: 0 });
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-subtract'));
    typeAmount('100');
    pickReason();

    fireEvent.click(confirmButton());

    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent(`${MINUS}40`);
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({ creditDelta: 40, creditReason: 'Undo: Goodwill credit' })
    );
  });

  it.each([undefined, 0])('does not offer unsafe undo for committed delta %s', async delta => {
    mocks.update.mockResolvedValueOnce({ currentCredits: 800, appliedCreditDelta: delta });
    const { onClose } = setup();
    typeAmount('800');
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('does not claim a balance when only the committed delta is returned', async () => {
    mocks.update.mockResolvedValueOnce({ appliedCreditDelta: 75 });
    setup();
    fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
    typeAmount('75');
    pickReason();
    fireEvent.click(confirmButton());

    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Credits adjusted (+75)');
    expect(screen.getByTestId('undo-toast-message')).not.toHaveTextContent('Balance set to');
  });

  it('keeps a deferred write single-submit and trims a free-text reason', async () => {
    let finish: (value: { appliedCreditDelta: number; currentCredits: number }) => void = () => {};
    mocks.update.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    setup();
    typeAmount('800');
    fireEvent.change(screen.getByTestId('adjust-credits-dialog-reason-input'), {
      target: { value: '  Support correction  ' },
    });
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ creditReason: 'Support correction' }));
    expect(confirmButton()).toBeDisabled();
    finish({ appliedCreditDelta: 300, currentCredits: 800 });
    expect(await screen.findByTestId('undo-toast')).toBeInTheDocument();
  });

  it('stays open without a toast when the write fails', async () => {
    mocks.update.mockRejectedValue(new Error('nope'));
    const { onClose } = setup();
    typeAmount('800');
    pickReason();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('refetches the balance on open and previews, sets and undoes from the fresh figure', async () => {
    mocks.update.mockResolvedValueOnce({ appliedCreditDelta: 150, currentCredits: 800 });
    let resolveRefetch: (credits: number) => void = () => undefined;
    const fetchCredits = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(500)
      .mockImplementationOnce(() => new Promise(resolve => (resolveRefetch = resolve)));
    render(
      <LiveProfile fetchCredits={fetchCredits}>
        {live => <AdjustCreditsDialog user={live} onClose={vi.fn()} />}
      </LiveProfile>,
      { wrapper: ProfileTestWrapper }
    );
    await waitFor(() => expect(fetchCredits).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId('adjust-credits-amount-input')).toBeDisabled();
    expect(screen.getByTestId('adjust-credits-dialog-reason-input-preset-0')).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(mocks.update).not.toHaveBeenCalled();

    resolveRefetch(650);
    await waitFor(() => expect(screen.getByTestId('adjust-credits-amount-input')).not.toBeDisabled());
    expect(screen.getByTestId('adjust-credits-preview-before')).toHaveTextContent('650');
    typeAmount('800');
    pickReason();
    expect(screen.getByTestId('adjust-credits-preview-delta')).toHaveTextContent('+150');

    fireEvent.click(confirmButton());
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({ creditDelta: -150, creditReason: 'Undo: Goodwill credit' })
    );
  });

  it('blocks confirm when the balance could not be refreshed', async () => {
    const fetchCredits = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(500)
      .mockRejectedValueOnce(new Error('network'));
    render(
      <LiveProfile fetchCredits={fetchCredits}>
        {live => <AdjustCreditsDialog user={live} onClose={vi.fn()} />}
      </LiveProfile>,
      { wrapper: ProfileTestWrapper }
    );
    await waitFor(() => expect(fetchCredits).toHaveBeenCalledTimes(2));
    typeAmount('800');
    pickReason();

    await waitFor(() =>
      expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent(
        'The current balance could not be loaded.'
      )
    );
    expect(confirmButton()).toBeDisabled();
  });

  describe('grant value and large-grant confirmation', () => {
    const grantValue = () => screen.queryByTestId('adjust-credits-grant-value');
    const typedInput = () => screen.queryByTestId('adjust-credits-dialog-typed-input');

    it('shows the dollar value of a grant and nothing for a deduction', () => {
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('100000');
      expect(grantValue()).toHaveTextContent('You are granting $60 worth of credits.');

      typeAmount('2500');
      expect(grantValue()).toHaveTextContent('You are granting $1.50 worth of credits.');

      fireEvent.click(screen.getByTestId('adjust-credits-mode-subtract'));
      typeAmount('100');
      expect(grantValue()).toBeNull();
    });

    it('prices a Set-to by the credits it adds over the balance', () => {
      setup();
      typeAmount('2500');
      expect(grantValue()).toHaveTextContent('You are granting $1.20 worth of credits.');
      expect(typedInput()).toBeNull();
    });

    it('asks for no phrase up to the room the server reports under 100,000', async () => {
      mocks.recentGrants.mockReturnValue(figures(30_000));
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('70000');
      pickReason();

      expect(typedInput()).toBeNull();
      expect(secondaryButton()).toBeNull();
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ creditDelta: 70_000, creditReason: 'Goodwill credit' })
      );
    });

    it('says before submit that the whole grant goes for approval, and sends it with the phrase', async () => {
      mocks.recentGrants.mockReturnValue(figures(30_000));
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('150000');
      pickReason();

      expect(screen.getByTestId('adjust-credits-grant-value-approval')).toHaveTextContent(
        'This takes the user above 100,000 admin-granted credits in 24 hours, so the whole grant goes to a senior granter for approval. Nothing is granted until it is approved.'
      );
      expect(screen.getByTestId('adjust-credits-dialog-typed-expected')).toHaveTextContent('I UNDERSTAND');
      expect(confirmButton()).toHaveTextContent('Submit for approval');
      expect(confirmButton()).toBeDisabled();
      fireEvent.change(typedInput()!, { target: { value: 'I UNDERSTAND' } });
      fireEvent.click(confirmButton());

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          creditDelta: 150_000,
          creditReason: 'Goodwill credit',
          confirmLargeGrant: true,
        })
      );
    });

    it('offers "Grant N now" with the room left under 100,000, without the phrase', async () => {
      mocks.recentGrants.mockReturnValue(figures(30_000));
      setup();
      typeAmount('150500');
      pickReason();

      expect(secondaryButton()).toHaveTextContent('Grant 70,000 now');
      expect(secondaryButton()).toBeEnabled();
      fireEvent.click(secondaryButton()!);

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ creditDelta: 70_000, creditReason: 'Goodwill credit' })
      );
    });

    it('lets a listed approver grant up to 500,000 at once after the phrase', async () => {
      mocks.recentGrants.mockReturnValue(figures(0, 500_000));
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('300000');
      pickReason();

      expect(screen.queryByTestId('adjust-credits-grant-value-approval')).toBeNull();
      expect(confirmButton()).toHaveTextContent('Set balance to 300,500');
      fireEvent.change(typedInput()!, { target: { value: 'I UNDERSTAND' } });
      fireEvent.click(confirmButton());

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          creditDelta: 300_000,
          creditReason: 'Goodwill credit',
          confirmLargeGrant: true,
        })
      );
    });

    it('blocks a grant past 500,000 in 24 hours and offers what is left, behind the phrase', async () => {
      mocks.recentGrants.mockReturnValue(figures(450_000, 500_000));
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('60000');
      pickReason();

      expect(screen.getByTestId('adjust-credits-dialog-hint')).toHaveTextContent(
        'No grant can take this user above 500,000 credits in 24 hours, approved or not.'
      );
      expect(confirmButton()).toBeDisabled();
      expect(secondaryButton()).toHaveTextContent('Grant 50,000 now');
      expect(secondaryButton()).toBeDisabled();
      fireEvent.change(typedInput()!, { target: { value: 'I UNDERSTAND' } });
      fireEvent.click(secondaryButton()!);

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          creditDelta: 50_000,
          creditReason: 'Goodwill credit',
          confirmLargeGrant: true,
        })
      );
    });

    it('plans a grant to the admin own account like any other: the server reports the same 100,000 limit', () => {
      // The endpoint gives a self-grant the standard limit unless the admin is a listed credits:self_grant holder.
      mocks.recentGrants.mockReturnValue(figures(0, 100_000));
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('50');
      pickReason();

      expect(screen.queryByTestId('adjust-credits-grant-value-approval')).toBeNull();
      expect(typedInput()).toBeNull();
      expect(secondaryButton()).toBeNull();
      expect(confirmButton()).not.toHaveTextContent('Submit for approval');
    });

    it('asks for the phrase past 100,000 while the figures are not loaded, and lets the server decide', () => {
      mocks.recentGrants.mockReturnValue({ isLoading: false, data: undefined, refetch: mocks.refetch });
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('150000');

      expect(typedInput()).not.toBeNull();
      expect(screen.queryByTestId('adjust-credits-grant-value-approval')).toBeNull();
    });

    it('refetches the figures after a grant-cap refusal, so the dialog re-plans', async () => {
      mocks.update.mockRejectedValueOnce(grantLimitRefusal());
      setup();
      fireEvent.click(screen.getByTestId('adjust-credits-mode-add'));
      typeAmount('20000');
      pickReason();

      fireEvent.click(confirmButton());
      await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
    });
  });
});
