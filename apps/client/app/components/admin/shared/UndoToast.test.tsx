import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { UNDO_TOAST_DURATION_MS, UndoToastProvider, type UndoToastOptions, useUndoToast } from './UndoToast';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>
    <UndoToastProvider>{children}</UndoToastProvider>
  </CssVarsProvider>
);

const Trigger = ({ options, testId = 'trigger-btn' }: { options: UndoToastOptions; testId?: string }) => {
  const showUndoToast = useUndoToast();
  return (
    <button data-testid={testId} onClick={() => showUndoToast(options)}>
      Write
    </button>
  );
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UndoToast', () => {
  it('runs the caller-supplied reverse action on Undo, then dismisses', async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    render(<Trigger options={{ message: 'Balance set to 0', onUndo }} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('trigger-btn'));
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Balance set to 0');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument());
  });

  it('keeps the toast and shows the failure when the reverse action throws', async () => {
    const onUndo = vi.fn().mockRejectedValue(new Error('Balance changed since; nothing was reverted.'));
    render(<Trigger options={{ message: 'Balance set to 0', onUndo }} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('trigger-btn'));
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    expect(await screen.findByTestId('undo-toast-error')).toHaveTextContent('Balance changed since');
    expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
  });

  it('offers the audit entry only when the caller supplies it', () => {
    const onViewAudit = vi.fn();
    render(
      <>
        <Trigger options={{ message: 'Plain', onUndo: vi.fn() }} testId="plain-btn" />
        <Trigger options={{ message: 'Audited', onUndo: vi.fn(), onViewAudit }} testId="audited-btn" />
      </>,
      { wrapper: TestWrapper }
    );

    fireEvent.click(screen.getByTestId('plain-btn'));
    expect(screen.queryByTestId('undo-toast-audit-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('audited-btn'));
    fireEvent.click(screen.getByTestId('undo-toast-audit-btn'));
    expect(onViewAudit).toHaveBeenCalledTimes(1);
  });

  it('shows one toast at a time: a new write replaces the previous offer', () => {
    const firstUndo = vi.fn();
    const secondUndo = vi.fn();
    render(
      <>
        <Trigger options={{ message: 'First write', onUndo: firstUndo }} testId="first-btn" />
        <Trigger options={{ message: 'Second write', onUndo: secondUndo }} testId="second-btn" />
      </>,
      { wrapper: TestWrapper }
    );

    fireEvent.click(screen.getByTestId('first-btn'));
    fireEvent.click(screen.getByTestId('second-btn'));

    expect(screen.getAllByTestId('undo-toast')).toHaveLength(1);
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Second write');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    expect(secondUndo).toHaveBeenCalledTimes(1);
    expect(firstUndo).not.toHaveBeenCalled();
  });

  it('dismisses itself after 30 seconds', () => {
    vi.useFakeTimers();
    render(<Trigger options={{ message: 'Balance set to 0', onUndo: vi.fn() }} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('trigger-btn'));

    act(() => vi.advanceTimersByTime(UNDO_TOAST_DURATION_MS - 1_000));
    expect(screen.getByTestId('undo-toast')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('fails loudly when used outside its provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useUndoToast())).toThrow('useUndoToast must be used within an UndoToastProvider');
  });
});
