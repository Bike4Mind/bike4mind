import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdjustCreditsDialog } from './AdjustCreditsDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('./useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));

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

describe('AdjustCreditsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
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
});
