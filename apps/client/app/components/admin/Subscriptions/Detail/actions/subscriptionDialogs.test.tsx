import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import { ExtendCompDialog } from './ExtendCompDialog';
import { EndCompDialog } from './EndCompDialog';
import { EditCreditsPerCycleDialog, parseCreditsPerCycle } from './EditCreditsPerCycleDialog';
import { RemoveSubscriptionDialog } from './RemoveSubscriptionDialog';
import { OWNER_ID, STRIPE_ROW, SubscriptionTestWrapper, buildDetail } from '../subscriptionDetailTestUtils';

const mocks = vi.hoisted(() => ({ comp: vi.fn(), credits: vi.fn(), remove: vi.fn() }));

vi.mock('@client/app/hooks/data/adminSubscriptionDetail', () => ({
  useAdminSubscriptionCompChange: () => ({ mutateAsync: mocks.comp }),
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useUpdateSubscriptionCredits: () => ({ mutateAsync: mocks.credits }),
  useRemoveSubscription: () => ({ mutateAsync: mocks.remove }),
}));

const MINUS = '\u2212';
const pickReason = (testId: string) => fireEvent.click(screen.getByTestId(`${testId}-reason-input-preset-0`));
const confirm = (testId: string) => fireEvent.click(screen.getByTestId(`${testId}-confirm-btn`));
const undo = () => fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

type Dialog = React.FC<{ detail: AdminSubscriptionDetail; onClose: () => void; onAudit: () => void }>;
const open = (Component: Dialog, detail: AdminSubscriptionDetail) => {
  const onClose = vi.fn();
  const onAudit = vi.fn();
  render(<Component detail={detail} onClose={onClose} onAudit={onAudit} />, { wrapper: SubscriptionTestWrapper });
  return { onClose, onAudit };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.comp.mockResolvedValue({});
  mocks.credits.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
});

describe('ExtendCompDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('extends from the current end and undoes back to it', async () => {
    const { onClose } = open(ExtendCompDialog, buildDetail());

    expect(screen.getByTestId('extend-comp-preview-before')).toHaveTextContent('1 Dec 2026');
    fireEvent.click(screen.getByTestId('extend-comp-months-3'));
    expect(screen.getByTestId('extend-comp-preview-after')).toHaveTextContent('1 Mar 2027');
    expect(screen.getByTestId('extend-comp-dialog')).toHaveTextContent('No credits are added');

    pickReason('extend-comp-dialog');
    expect(screen.getByTestId('extend-comp-dialog-confirm-btn')).toHaveTextContent('Extend to 1 Mar 2027');
    confirm('extend-comp-dialog');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [body] = mocks.comp.mock.calls[0];
    expect(body).toMatchObject({ action: 'setEndsAt', periodEndsAt: '2027-03-01T00:00:00.000Z' });
    expect(typeof body.reason).toBe('string');

    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Comp extended to 1 Mar 2027');
    undo();
    await waitFor(() => expect(mocks.comp).toHaveBeenCalledTimes(2));
    expect(mocks.comp.mock.calls[1][0]).toEqual({
      action: 'setEndsAt',
      periodEndsAt: '2026-12-01T00:00:00.000Z',
      reason: `Undo: ${body.reason}`,
    });
  });

  it('extends a lapsed comp from today', () => {
    open(ExtendCompDialog, buildDetail({ subscription: { periodEndsAt: '2026-01-01T00:00:00.000Z' } }));
    expect(screen.getByTestId('extend-comp-preview-after')).toHaveTextContent('29 Nov 2026');
  });

  it('stays open when the write fails', async () => {
    mocks.comp.mockRejectedValueOnce(new Error('nope'));
    const { onClose } = open(ExtendCompDialog, buildDetail());
    pickReason('extend-comp-dialog');
    confirm('extend-comp-dialog');

    await waitFor(() => expect(mocks.comp).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('extend-comp-dialog')).toBeInTheDocument();
  });
});

describe('EndCompDialog', () => {
  it('ends the comp and undoes by reopening it', async () => {
    const { onClose, onAudit } = open(EndCompDialog, buildDetail());

    expect(screen.getByTestId('end-comp-preview-before')).toHaveTextContent('Active');
    expect(screen.getByTestId('end-comp-preview-after')).toHaveTextContent('Canceled');
    expect(screen.getByTestId('end-comp-dialog')).toHaveTextContent('Credits already granted stay with the owner.');

    pickReason('end-comp-dialog');
    confirm('end-comp-dialog');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [body] = mocks.comp.mock.calls[0];
    expect(body.action).toBe('end');

    fireEvent.click(screen.getByTestId('undo-toast-audit-btn'));
    expect(onAudit).toHaveBeenCalled();
    undo();
    await waitFor(() =>
      expect(mocks.comp).toHaveBeenLastCalledWith({ action: 'reopen', reason: `Undo: ${body.reason}` })
    );
  });
});

describe('EditCreditsPerCycleDialog', () => {
  it('sets an override with a signed delta and undoes back to the plan default', async () => {
    const { onClose } = open(EditCreditsPerCycleDialog, buildDetail());

    fireEvent.change(screen.getByTestId('edit-credits-per-cycle-input'), { target: { value: '750' } });
    expect(screen.getByTestId('edit-credits-per-cycle-preview-before')).toHaveTextContent('1,000');
    expect(screen.getByTestId('edit-credits-per-cycle-preview-after')).toHaveTextContent('750');
    expect(screen.getByTestId('edit-credits-per-cycle-preview-delta')).toHaveTextContent(`${MINUS}250`);

    pickReason('edit-credits-per-cycle-dialog');
    confirm('edit-credits-per-cycle-dialog');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [body] = mocks.credits.mock.calls[0];
    expect(body).toMatchObject({ userId: OWNER_ID, subscriptionId: 'admin_grant_1', creditsPerCycle: 750 });

    undo();
    await waitFor(() => expect(mocks.credits).toHaveBeenCalledTimes(2));
    expect(mocks.credits.mock.calls[1][0]).toMatchObject({ creditsPerCycle: null, reason: `Undo: ${body.reason}` });
  });

  it('clears an override with Use plan default and undoes back to the old override', async () => {
    const detail = buildDetail({
      credits: { defaultPerCycle: 1000, customPerCycle: 4000, effectivePerCycle: 4000, recentGrants: [] },
    });
    const { onClose } = open(EditCreditsPerCycleDialog, detail);

    fireEvent.click(screen.getByTestId('edit-credits-per-cycle-default-checkbox'));
    expect(screen.getByTestId('edit-credits-per-cycle-preview-after')).toHaveTextContent('1,000');
    pickReason('edit-credits-per-cycle-dialog');
    confirm('edit-credits-per-cycle-dialog');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.credits.mock.calls[0][0]).toMatchObject({ creditsPerCycle: null });
    undo();
    await waitFor(() =>
      expect(mocks.credits).toHaveBeenLastCalledWith(expect.objectContaining({ creditsPerCycle: 4000 }))
    );
  });

  it('blocks a non-positive or fractional amount in place', () => {
    open(EditCreditsPerCycleDialog, buildDetail());
    fireEvent.change(screen.getByTestId('edit-credits-per-cycle-input'), { target: { value: '0' } });
    pickReason('edit-credits-per-cycle-dialog');
    expect(screen.getByTestId('edit-credits-per-cycle-dialog-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('edit-credits-per-cycle-dialog-hint')).toHaveTextContent('above 0');
  });

  it('parses thousands separators and rejects anything else', () => {
    expect(parseCreditsPerCycle('12,500')).toBe(12500);
    expect(parseCreditsPerCycle('1.5')).toBeNull();
    expect(parseCreditsPerCycle('-3')).toBeNull();
    expect(parseCreditsPerCycle('')).toBeNull();
  });
});

describe('RemoveSubscriptionDialog', () => {
  const openRemove = (detail: AdminSubscriptionDetail) => {
    const onClose = vi.fn();
    const onRemoved = vi.fn();
    render(<RemoveSubscriptionDialog detail={detail} onClose={onClose} onRemoved={onRemoved} />, {
      wrapper: SubscriptionTestWrapper,
    });
    return { onClose, onRemoved };
  };

  it('removes a comp after the owner name is typed, with no undo', async () => {
    const { onRemoved } = openRemove(buildDetail());
    expect(screen.getByTestId('remove-subscription-dialog')).toHaveTextContent('This cannot be undone.');

    pickReason('remove-subscription-dialog');
    expect(screen.getByTestId('remove-subscription-dialog-confirm-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('remove-subscription-dialog-typed-input'), {
      target: { value: 'Ada Lovelace' },
    });
    confirm('remove-subscription-dialog');

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(mocks.remove.mock.calls[0][0]).toMatchObject({ userId: OWNER_ID, subscriptionId: 'admin_grant_1' });
    expect(screen.queryByTestId('undo-toast-undo-btn')).not.toBeInTheDocument();
  });

  it('refuses a live Stripe row', () => {
    openRemove(buildDetail({ subscription: STRIPE_ROW }));
    expect(screen.getByTestId('remove-subscription-dialog-hint')).toHaveTextContent('Cancel it first');
  });
});
