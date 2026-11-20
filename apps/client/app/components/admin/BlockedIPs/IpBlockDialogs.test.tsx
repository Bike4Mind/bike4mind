import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  block: vi.fn(),
  unblock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/admin', () => ({
  useBlockIP: () => ({ mutateAsync: h.block, isPending: false }),
  useUnblockIP: () => ({ mutateAsync: h.unblock, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { BlockIpDialog, UnblockIpDialog } from './IpBlockDialogs';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const confirmButton = (dialog: string) => screen.getByTestId(`${dialog}-confirm-btn`);
const pickFirstReason = (dialog: string) => fireEvent.click(screen.getByTestId(`${dialog}-reason-input-preset-0`));

describe('BlockIpDialog', () => {
  beforeEach(() => {
    h.block.mockReset().mockResolvedValue({ created: true, alreadyBlocked: false, extended: false });
    h.toastSuccess.mockReset();
    h.toastError.mockReset();
  });

  it('prefills the IP and blocks it for every surface for 24 hours by default', async () => {
    const onClose = vi.fn();
    render(<BlockIpDialog initialIp="203.0.113.7" onClose={onClose} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('block-ip-dialog-ip-input')).toHaveValue('203.0.113.7');
    pickFirstReason('block-ip-dialog');
    fireEvent.click(confirmButton('block-ip-dialog'));

    await waitFor(() =>
      expect(h.block).toHaveBeenCalledWith({
        ip: '203.0.113.7',
        scope: 'all',
        duration: '24h',
        reason: 'Card testing or payment fraud',
      })
    );
    expect(h.toastSuccess).toHaveBeenCalledWith('IP blocked');
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ['', 'Enter an IP address or range.'],
    ['not-an-ip', 'IPv4 or IPv6'],
    ['10.0.0.0/8', '/16'],
  ])('refuses %j before it reaches the server', (value, hint) => {
    render(<BlockIpDialog onClose={vi.fn()} />, { wrapper: TestWrapper });
    fireEvent.change(screen.getByTestId('block-ip-dialog-ip-input'), { target: { value } });
    pickFirstReason('block-ip-dialog');

    expect(confirmButton('block-ip-dialog')).toBeDisabled();
    expect(screen.getByTestId('block-ip-dialog-hint').textContent).toContain(hint);
  });

  it('reports an extended block', async () => {
    h.block.mockResolvedValue({ created: false, alreadyBlocked: true, extended: true });
    render(<BlockIpDialog initialIp="2001:db8::/48" onClose={vi.fn()} />, { wrapper: TestWrapper });
    pickFirstReason('block-ip-dialog');
    fireEvent.click(confirmButton('block-ip-dialog'));

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Block extended'));
  });

  it('keeps the dialog open and toasts the server error on failure', async () => {
    h.block.mockRejectedValue(new Error('This would block your own IP address.'));
    const onClose = vi.fn();
    render(<BlockIpDialog initialIp="203.0.113.7" onClose={onClose} />, { wrapper: TestWrapper });
    pickFirstReason('block-ip-dialog');
    fireEvent.click(confirmButton('block-ip-dialog'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('UnblockIpDialog', () => {
  it('renders nothing without a block', () => {
    render(<UnblockIpDialog block={null} onClose={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('unblock-ip-dialog')).not.toBeInTheDocument();
  });

  it('lifts the block by id with a reason', async () => {
    h.unblock.mockReset().mockResolvedValue({});
    const onClose = vi.fn();
    const block = { _id: 'b1', ip: '203.0.113.0/24', blockedAt: '2026-10-01', expiresAt: '2026-10-02' };
    render(<UnblockIpDialog block={block} onClose={onClose} />, { wrapper: TestWrapper });
    pickFirstReason('unblock-ip-dialog');
    fireEvent.click(confirmButton('unblock-ip-dialog'));

    await waitFor(() => expect(h.unblock).toHaveBeenCalledWith({ id: 'b1', reason: 'Blocked in error' }));
    expect(onClose).toHaveBeenCalled();
  });
});
