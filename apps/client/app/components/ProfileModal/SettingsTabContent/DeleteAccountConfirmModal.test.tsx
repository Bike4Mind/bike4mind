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
    h.status = {
      data: { deletion: null, ownedOrganizations: [], soleOwnedOrganizations: [] },
      isLoading: false,
    };
  });

  it('says what happens now, when the purge lands and how to cancel', () => {
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    const text = screen.getByTestId('delete-account-confirm').textContent;
    expect(text).toContain('signed out on every device right away');
    expect(text).toContain('subscriptions will be canceled');
    expect(text).toMatch(/Your cancellation period ends on \w+ \d{1,2}, \d{4}/);
    expect(text).toContain('Permanent deletion begins after that date');
    expect(text).toContain('cancel until cleanup starts');
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
    h.status = {
      data: { deletion: null, ownedOrganizations: [{ id: 'org-1', name: 'Acme' }], soleOwnedOrganizations: [] },
      isLoading: false,
    };
    const onCancel = vi.fn();
    wrap(<DeleteAccountConfirm onCancel={onCancel} />);
    expect(screen.getByTestId('delete-account-org-owner').textContent).toContain('Transfer ownership');
    expect(screen.queryByTestId('delete-account-confirm-input')).toBeNull();
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('delete-account-org-link'));
    expect(onCancel).toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith({ to: '/organizations/$id', params: { id: 'org-1' } });
  });

  it('names the organizations that will be deleted with the account and keeps the email confirmation', () => {
    h.status = {
      data: {
        deletion: null,
        ownedOrganizations: [],
        soleOwnedOrganizations: [
          { id: 'org-1', name: 'Acme' },
          { id: 'org-2', name: 'Side Project' },
        ],
      },
      isLoading: false,
    };
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    const text = screen.getByTestId('delete-account-sole-owned-orgs').textContent;
    expect(text).toContain('will be deleted along with your account');
    expect(text).toContain('Acme, Side Project');
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('delete-account-confirm-input'), { target: { value: 'ada@example.test' } });
    expect(confirmBtn().disabled).toBe(false);
  });

  it('caps a long list of sole-owned organizations', () => {
    h.status = {
      data: {
        deletion: null,
        ownedOrganizations: [],
        soleOwnedOrganizations: Array.from({ length: 7 }, (_, i) => ({ id: `org-${i}`, name: `Org ${i}` })),
      },
      isLoading: false,
    };
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    const text = screen.getByTestId('delete-account-sole-owned-orgs').textContent;
    expect(text).toContain('Org 0, Org 1, Org 2, Org 3, Org 4 and 2 more');
    expect(text).not.toContain('Org 5');
  });

  const soleOrgsText = (count: number) => {
    h.status = {
      data: {
        deletion: null,
        ownedOrganizations: [],
        soleOwnedOrganizations: Array.from({ length: count }, (_, i) => ({ id: `org-${i}`, name: `Org ${i}` })),
      },
      isLoading: false,
    };
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    return screen.getByTestId('delete-account-sole-owned-orgs').textContent;
  };

  it('uses singular copy for exactly one sole-owned organization', () => {
    const text = soleOrgsText(1);
    expect(text).toContain('only member of this team');
    expect(text).toContain('so it will be deleted');
    expect(text).toContain('Org 0');
    expect(text).not.toContain('more');
  });

  it('lists exactly five sole-owned organizations without a remainder', () => {
    const text = soleOrgsText(5);
    expect(text).toContain('Org 0, Org 1, Org 2, Org 3, Org 4');
    expect(text).not.toContain('more');
  });

  it('adds a remainder for the sixth sole-owned organization', () => {
    const text = soleOrgsText(6);
    expect(text).toContain('Org 0, Org 1, Org 2, Org 3, Org 4 and 1 more');
    expect(text).not.toContain('Org 5');
  });

  it('shows no organization notice when the user has no sole-owned organization', () => {
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    expect(screen.queryByTestId('delete-account-sole-owned-orgs')).toBeNull();
  });

  it('still blocks on shared organizations even when sole-owned ones exist', () => {
    h.status = {
      data: {
        deletion: null,
        ownedOrganizations: [{ id: 'org-1', name: 'Acme' }],
        soleOwnedOrganizations: [{ id: 'org-2', name: 'Side Project' }],
      },
      isLoading: false,
    };
    wrap(<DeleteAccountConfirm onCancel={vi.fn()} />);
    expect(screen.getByTestId('delete-account-org-owner')).toBeTruthy();
    expect(screen.queryByTestId('delete-account-sole-owned-orgs')).toBeNull();
    expect(confirmBtn().disabled).toBe(true);
  });
});
