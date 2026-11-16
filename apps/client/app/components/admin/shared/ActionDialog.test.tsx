import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { ActionDialog, type ActionDialogProps } from './ActionDialog';
import { ACCEPTED_AI_REASON, isAdminReasonComplete } from './adminReason';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const PRESETS = ['Goodwill credit', 'Billing correction'];

type HarnessProps = Partial<Omit<ActionDialogProps, 'open' | 'onClose'>> & { onClose?: () => void };

/** Mirrors a real caller: an opener button that toggles the dialog. */
const Harness = ({ onClose, onConfirm = vi.fn(), ...props }: HarnessProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="opener-btn" onClick={() => setOpen(true)}>
        Adjust credits
      </button>
      <ActionDialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Adjust credits"
        reasonPresets={PRESETS}
        confirmLabel="Set balance to 0"
        onConfirm={onConfirm}
        data-testid="adjust-dialog"
        {...props}
      />
    </>
  );
};

const openDialog = (props: HarnessProps = {}) => {
  render(<Harness {...props} />, { wrapper: TestWrapper });
  fireEvent.click(screen.getByTestId('opener-btn'));
  return screen.getByTestId('adjust-dialog-confirm-btn');
};

describe('ActionDialog', () => {
  it('allows a reason-free command when the caller policy does not require one', async () => {
    const onConfirm = vi.fn();
    const confirm = openDialog({ onConfirm, reasonRequired: false });
    expect(confirm).toBeEnabled();
    expect(screen.queryByTestId('adjust-dialog-reason-input')).not.toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''));
  });

  it('still gates a reason-free command on typed confirmation', () => {
    const confirm = openDialog({ reasonRequired: false, typedConfirm: { expected: 'queue', noun: 'queue name' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('adjust-dialog-typed-input'), { target: { value: 'queue' } });
    expect(confirm).toBeEnabled();
  });

  it('seeds a complete, editable reason from initialReason', async () => {
    const onConfirm = vi.fn();
    expect(isAdminReasonComplete(ACCEPTED_AI_REASON)).toBe(true);
    const confirm = openDialog({ onConfirm, initialReason: ACCEPTED_AI_REASON });

    expect(screen.getByTestId('adjust-dialog-reason-input')).toHaveValue('Accepted AI suggestion');
    expect(confirm).toBeEnabled();
    fireEvent.change(screen.getByTestId('adjust-dialog-reason-input'), {
      target: { value: 'Accepted AI suggestion, checked the logs' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Accepted AI suggestion, checked the logs'));
  });

  it('re-seeds the reason when formKey changes while open', () => {
    const { rerender } = render(
      <ActionDialog
        open
        onClose={vi.fn()}
        title="Grade"
        reasonPresets={PRESETS}
        confirmLabel="Record"
        onConfirm={vi.fn()}
        data-testid="grade-dialog"
        formKey={0}
      />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('grade-dialog-reason-input')).toHaveValue('');
    rerender(
      <ActionDialog
        open
        onClose={vi.fn()}
        title="Grade"
        reasonPresets={PRESETS}
        confirmLabel="Record"
        onConfirm={vi.fn()}
        data-testid="grade-dialog"
        formKey={1}
        initialReason={ACCEPTED_AI_REASON}
      />
    );
    expect(screen.getByTestId('grade-dialog-reason-input')).toHaveValue('Accepted AI suggestion');
  });

  it('names the command, repeats the consequence on the commit button and labels the dialog', () => {
    const confirm = openDialog({ description: 'Credits drop to zero immediately.' });

    expect(screen.getByRole('dialog', { name: 'Adjust credits' })).toBeInTheDocument();
    expect(confirm).toHaveTextContent('Set balance to 0');
    expect(screen.getByText('Credits drop to zero immediately.')).toBeInTheDocument();
  });

  it('explains a disabled commit in place and links the hint to the button', () => {
    const confirm = openDialog();

    expect(confirm).toBeDisabled();
    const hint = screen.getByTestId('adjust-dialog-hint');
    expect(hint).toHaveTextContent('Pick a reason or write at least 5 characters.');
    expect(confirm).toHaveAttribute('aria-describedby', hint.id);
  });

  it('accepts a preset alone and passes it as the reason', async () => {
    const onConfirm = vi.fn();
    const confirm = openDialog({ onConfirm });

    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    expect(screen.queryByTestId('adjust-dialog-hint')).not.toBeInTheDocument();
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Goodwill credit'));
  });

  it('offers a gated secondary commit that gets the same reason and not the primary handler', async () => {
    const onConfirm = vi.fn();
    const onSecondary = vi.fn();
    openDialog({ onConfirm, secondaryAction: { label: 'Save and next', onConfirm: onSecondary } });
    const secondary = screen.getByTestId('adjust-dialog-secondary-btn');

    expect(secondary).toBeDisabled();
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    expect(secondary).toBeEnabled();
    fireEvent.click(secondary);

    await waitFor(() => expect(onSecondary).toHaveBeenCalledWith('Goodwill credit'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('combines a preset and a note as "Preset: note"', async () => {
    const onConfirm = vi.fn();
    const confirm = openDialog({ onConfirm });

    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-1'));
    fireEvent.change(screen.getByTestId('adjust-dialog-reason-input'), { target: { value: '  invoice 42  ' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Billing correction: invoice 42'));
  });

  it("shows the caller's blocked reason first and keeps the commit disabled", () => {
    const confirm = openDialog({ blockedReason: 'Enter a balance of 0 or more.' });
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));

    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('adjust-dialog-hint')).toHaveTextContent('Enter a balance of 0 or more.');
  });

  it('requires the typed name for an irreversible command', async () => {
    const onConfirm = vi.fn();
    const confirm = openDialog({ onConfirm, typedConfirm: { expected: 'ada@example.com', noun: 'email address' } });

    expect(screen.getByTestId('adjust-dialog-typed-expected')).toHaveTextContent('ada@example.com');
    // the sentence sits in one inline span so the spaces around the name survive the label's flex row
    expect(screen.getByTestId('adjust-dialog-typed-expected').parentElement?.tagName).toBe('SPAN');
    expect(screen.getByTestId('adjust-dialog-typed-expected')).toHaveStyle({ display: 'inline' });
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('adjust-dialog-hint')).toHaveTextContent('Type the email address exactly to confirm.');

    fireEvent.change(screen.getByTestId('adjust-dialog-typed-input'), { target: { value: 'ada@example' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('adjust-dialog-typed-input'), { target: { value: 'ada@example.com' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Goodwill credit'));
  });

  it('holds Cancel and shows the commit loading while the write is in flight', () => {
    const confirm = openDialog({ pending: true });

    expect(confirm).toHaveClass('MuiButton-loading');
    expect(screen.getByTestId('adjust-dialog-cancel-btn')).toBeDisabled();
  });

  it('holds Cancel until a confirm that returns a promise settles', async () => {
    let finish: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const confirm = openDialog({ onConfirm });
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByTestId('adjust-dialog-cancel-btn')).toBeDisabled());
    finish?.();
    await waitFor(() => expect(screen.getByTestId('adjust-dialog-cancel-btn')).toBeEnabled());
  });

  it('keeps Cancel enabled mid-write when the caller stops at close', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn(() => new Promise<void>(() => {}));
    const confirm = openDialog({ onConfirm, onClose, cancelStopsWrite: true });
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toHaveClass('MuiButton-loading'));
    expect(screen.getByTestId('adjust-dialog-cancel-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('adjust-dialog-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the required star on the typed-confirm sentence instead of a line of its own', () => {
    openDialog({ typedConfirm: { expected: 'a-very-long-address-that-wraps@example.com', noun: 'email address' } });

    const star = screen.getByTestId('adjust-dialog-typed-required');
    // same inline span as the name, joined by a non-breaking space, so a wrap never strands the star
    expect(star.parentElement).toBe(screen.getByTestId('adjust-dialog-typed-expected').parentElement);
    expect(star).toHaveTextContent('*');
    expect(star.textContent?.charCodeAt(0)).toBe(0xa0);
    expect(star).toHaveAttribute('aria-hidden', 'true');
    // Joy's own star, a separate flex item, is hidden
    const joyStar = star.closest('label')?.querySelector('.MuiFormLabel-asterisk');
    expect(joyStar).not.toBeNull();
    expect(joyStar).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('adjust-dialog-typed-input')).toBeRequired();
  });

  it('reserves solid danger for the final confirm only', () => {
    const confirm = openDialog({ tone: 'danger' });

    expect(confirm.className).toContain('MuiButton-colorDanger');
    expect(confirm).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByTestId('adjust-dialog-cancel-btn').className).not.toContain('MuiButton-colorDanger');
  });

  // Callers assert the tone through `data-tone`, so it has to follow the color the confirm renders.
  it('marks the confirm neutral, and not danger-colored, by default', () => {
    const confirm = openDialog();

    expect(confirm).toHaveAttribute('data-tone', 'neutral');
    expect(confirm.className).not.toContain('MuiButton-colorDanger');
  });

  it('commits on Enter from an input inside the dialog', async () => {
    const onConfirm = vi.fn();
    openDialog({
      onConfirm,
      children: <input data-testid="balance-input" defaultValue="0" />,
    });
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));

    const user = userEvent.setup();
    await user.type(screen.getByTestId('balance-input'), '{Enter}');

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Goodwill credit'));
  });

  it('closes on Esc and returns focus to the opener', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />, { wrapper: TestWrapper });
    const opener = screen.getByTestId('opener-btn');
    await user.click(opener);
    expect(screen.getByTestId('adjust-dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('adjust-dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('traps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: TestWrapper });
    await user.click(screen.getByTestId('opener-btn'));
    const dialog = screen.getByTestId('adjust-dialog');

    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let step = 0; step < 8; step += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('starts fresh each time it opens', () => {
    const confirm = openDialog();
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    expect(confirm).toBeEnabled();

    fireEvent.click(screen.getByTestId('adjust-dialog-cancel-btn'));
    fireEvent.click(screen.getByTestId('opener-btn'));

    expect(screen.getByTestId('adjust-dialog-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('adjust-dialog-reason-input-preset-0')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('ActionDialog pending ownership', () => {
  it('holds edits, every dismissal path and duplicate submits until a rejected request settles', async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject;
        })
    );
    const onClose = vi.fn();
    const changed = vi.fn();
    const confirm = openDialog({
      onConfirm,
      onClose,
      children: <input aria-label="Draft value" defaultValue="original" onChange={changed} />,
    });
    fireEvent.click(screen.getByTestId('adjust-dialog-reason-input-preset-0'));
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const input = screen.getByRole('textbox', { name: 'Draft value' });
    expect(input).toBeDisabled();
    await userEvent.type(input, 'late');
    fireEvent.change(input, { target: { value: 'late' } });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('adjust-dialog-reason-input')).toBeDisabled();
    expect(screen.getByTestId('adjust-dialog-close-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('adjust-dialog-close-btn'));
    await userEvent.keyboard('{Escape}');
    const backdrop = document.querySelector('.MuiModal-backdrop');
    if (!backdrop) throw new Error('Modal backdrop missing');
    fireEvent.click(backdrop);
    fireEvent.submit(confirm.closest('form')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledOnce();
    await act(async () => {
      rejectRequest?.(new Error('Request failed'));
    });
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.getByTestId('adjust-dialog-reason-input-preset-0')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('adjust-dialog-close-btn'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
