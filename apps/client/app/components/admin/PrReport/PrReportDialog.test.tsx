import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';

/**
 * PR report generator - the send-state machine.
 *
 * These pin the client half of the double-post guarantee: once a delivery is
 * unconfirmed, ONLY the explicit "I checked the channel" confirmation may re-arm Send -
 * not an edit, not Regenerate - and an in-flight send cannot be abandoned via Close.
 */

const { generateMutate, sendMutateAsync } = vi.hoisted(() => ({
  generateMutate: vi.fn(),
  sendMutateAsync: vi.fn(),
}));

vi.mock('@client/app/hooks/data/prReport', () => ({
  useGeneratePrReport: () => ({ mutate: generateMutate, isPending: false }),
  useSendPrReport: () => ({ mutateAsync: sendMutateAsync }),
}));

import { PrReportDialog } from './PrReportDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeReport = () => ({
  text: 'PR Status Digest\n- owed by <@U0WESCARD>',
  prCount: 1,
  warnings: { approvalDataUnavailable: false, openPrListTruncated: false },
  mentionNames: { U0WESCARD: 'Wes Carda' },
  mentionNamesUnavailable: false,
  identityMapErrors: [],
});

function renderDialog() {
  const onClose = vi.fn();
  return { onClose, ...render(<PrReportDialog open onClose={onClose} />, { wrapper }) };
}

// Escape reaches Joy's Modal keydown handler by bubbling from any element inside the
// dialog; the send button is always mounted, so it is a stable target.
function pressEscape() {
  fireEvent.keyDown(screen.getByTestId('pr-report-send-btn'), { key: 'Escape', code: 'Escape' });
}

beforeEach(() => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `uuid-${Date.now()}-${Math.random()}` });
  }
  generateMutate.mockReset();
  sendMutateAsync.mockReset();
  // Auto-generate on open resolves synchronously into a ready draft.
  generateMutate.mockImplementation((_input: unknown, opts: { onSuccess: (r: unknown) => void }) => {
    opts.onSuccess(makeReport());
  });
});

describe('PrReportDialog send-state machine', () => {
  it('sends and reports success, then keeps Send locked', async () => {
    const user = userEvent.setup();
    sendMutateAsync.mockResolvedValue({ outcome: 'sent' });
    renderDialog();

    expect(screen.getByTestId('pr-report-send-btn')).not.toBeDisabled();
    await user.click(screen.getByTestId('pr-report-send-btn'));

    expect(await screen.findByText(/Posted to Slack/i)).toBeInTheDocument();
    expect(screen.getByTestId('pr-report-send-btn')).toBeDisabled();
  });

  it('does NOT re-arm Send when the draft is edited during an unconfirmed delivery', async () => {
    const user = userEvent.setup();
    sendMutateAsync.mockResolvedValue({ outcome: 'deliveryUnknown' });
    renderDialog();

    await user.click(screen.getByTestId('pr-report-send-btn'));

    // deliveryUnknown: the check-the-channel gate is up and Send is locked.
    expect(await screen.findByTestId('pr-report-confirm-resend-btn')).toBeInTheDocument();
    expect(screen.getByTestId('pr-report-send-btn')).toBeDisabled();

    // Editing the draft must NOT silently clear the gate.
    await user.type(screen.getByRole('textbox'), ' extra');
    expect(screen.getByTestId('pr-report-send-btn')).toBeDisabled();
    expect(screen.getByTestId('pr-report-confirm-resend-btn')).toBeInTheDocument();

    // Only the deliberate acknowledgement re-arms it.
    await user.click(screen.getByTestId('pr-report-confirm-resend-btn'));
    expect(screen.getByTestId('pr-report-send-btn')).not.toBeDisabled();
    expect(screen.queryByTestId('pr-report-confirm-resend-btn')).toBeNull();
  });

  it('locks Regenerate and Close while a send is in flight, and Regenerate while delivery is unconfirmed', async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: unknown) => void;
    sendMutateAsync.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSend = resolve;
        })
    );
    renderDialog();

    await user.click(screen.getByTestId('pr-report-send-btn'));

    // In flight: nothing that could race the continuation or abandon it is usable.
    await waitFor(() => expect(screen.getByTestId('pr-report-regenerate-btn')).toBeDisabled());
    expect(screen.getByTestId('pr-report-close-btn')).toBeDisabled();
    expect(screen.getByTestId('pr-report-send-btn')).toBeDisabled();

    await act(async () => {
      resolveSend({ outcome: 'deliveryUnknown' });
    });

    // Unconfirmed: Regenerate AND Close stay locked so neither can reset state past the
    // warning (Close would unmount the dialog, and the next open re-arms with a fresh key).
    expect(await screen.findByTestId('pr-report-confirm-resend-btn')).toBeInTheDocument();
    expect(screen.getByTestId('pr-report-regenerate-btn')).toBeDisabled();
    expect(screen.getByTestId('pr-report-close-btn')).toBeDisabled();
  });

  it('IS dismissable via Escape when idle (control - proves the gated cases are real)', async () => {
    // Without this, the two non-dismissal tests could pass simply because Escape never
    // reaches Joy's handler in jsdom. Here onClose is wired, so Escape must fire it.
    const { onClose } = renderDialog();
    expect(screen.getByTestId('pr-report-send-btn')).not.toBeDisabled();

    pressEscape();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cannot be dismissed via Escape while a send is in flight', async () => {
    const user = userEvent.setup();
    let resolveSend!: (value: unknown) => void;
    sendMutateAsync.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSend = resolve;
        })
    );
    const { onClose } = renderDialog();

    await user.click(screen.getByTestId('pr-report-send-btn'));
    await waitFor(() => expect(screen.getByTestId('pr-report-send-btn')).toBeDisabled());

    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('pr-report-send-btn')).toBeInTheDocument();

    await act(async () => {
      resolveSend({ outcome: 'sent' });
    });
  });

  it('cannot be dismissed via Escape during an unconfirmed delivery', async () => {
    const user = userEvent.setup();
    sendMutateAsync.mockResolvedValue({ outcome: 'deliveryUnknown' });
    const { onClose } = renderDialog();

    await user.click(screen.getByTestId('pr-report-send-btn'));
    expect(await screen.findByTestId('pr-report-confirm-resend-btn')).toBeInTheDocument();

    // Escape must not slip past the "I checked the channel" gate.
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('pr-report-confirm-resend-btn')).toBeInTheDocument();
  });
});
