import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  status: { data: undefined as unknown, isLoading: false },
  mutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@client/app/hooks/data/accountDeletion', () => ({
  useAccountDeletionStatus: () => h.status,
  useRequestAccountDeletion: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: unknown) => unknown) => select({ currentUser: { email: 'Ada@Example.test' } }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));

import { DeleteAccountConfirm } from './DeleteAccountConfirmModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const confirmBtn = () => screen.getByTestId('confirm-modal-confirm-btn') as HTMLButtonElement;

describe('DeleteAccountConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.status = { data: { deletion: null, ownedOrganizations: [] }, isLoading: false };
  });

  it('says what happens now, when the purge lands and how to cancel', () => {
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    const text = screen.getByTestId('delete-account-confirm').textContent;
    expect(text).toContain('signed out on every device right away');
    expect(text).toContain('subscriptions will be canceled');
    expect(text).toMatch(/permanently deleted on \w+ \d{1,2}, \d{4}/);
    expect(text).toContain('cancel the deletion');
  });

  it('suggests downloading the data before deleting', () => {
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    expect(screen.getByTestId('delete-account-confirm').textContent).toContain('Download your data');
  });

  it('enables the delete only once the account email is typed', () => {
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    expect(confirmBtn().disabled).toBe(true);
    const input = screen.getByTestId('delete-account-confirm-input');
    fireEvent.change(input, { target: { value: 'someone@example.test' } });
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' ada@example.test ' } });
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });

  it('tells an organization owner to transfer or delete each organization first and links to it', () => {
    h.status = { data: { deletion: null, ownedOrganizations: [{ id: 'org-1', name: 'Acme' }] }, isLoading: false };
    const onCancel = vi.fn();
    wrap(<DeleteAccountConfirm onCancel={onCancel} />);
    expect(screen.getByTestId('delete-account-org-owner').textContent).toContain('Transfer ownership');
    expect(screen.queryByTestId('delete-account-confirm-input')).toBeNull();
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('delete-account-org-link'));
    expect(onCancel).toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith({ to: '/organizations/$id', params: { id: 'org-1' } });
  });
});
