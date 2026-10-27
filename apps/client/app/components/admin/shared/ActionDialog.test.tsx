import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { ActionDialog, type ActionDialogProps } from './ActionDialog';

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

  it('reserves solid danger for the final confirm only', () => {
    const confirm = openDialog({ tone: 'danger' });

    expect(confirm.className).toContain('MuiButton-colorDanger');
    expect(screen.getByTestId('adjust-dialog-cancel-btn').className).not.toContain('MuiButton-colorDanger');
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
