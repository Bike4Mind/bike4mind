import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { OAUTH_CLIENT_MAX_ROLES, type OAuthClientView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const api = vi.hoisted(() => ({
  fetchOAuthClientRoles: vi.fn(),
  addOAuthClientRole: vi.fn(),
  removeOAuthClientRole: vi.fn(),
}));
vi.mock('@client/app/utils/oauthClientAPICalls', () => api);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OAuthClientRolesSection, newRoleBlockedReason } from './OAuthClientRolesSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const client = {
  id: 'c1',
  clientId: 'b4m_my_app_0011aabb',
  name: 'My App',
  roles: [],
} as unknown as OAuthClientView;
const admin = { key: 'admin', label: 'Admin' };
const viewer = { key: 'viewer', label: 'Viewer' };
const holder = (over: Record<string, unknown>) => ({
  userId: 'u1',
  role: 'admin',
  email: null,
  name: null,
  assignedBy: 'a1',
  assignedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const onClose = vi.fn();
const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <OAuthClientRolesSection client={client} onClose={onClose} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const pickReason = (modal: 'add' | 'remove') =>
  fireEvent.click(screen.getByTestId(`oauth-client-role-${modal}-modal-reason-input-preset-0`));

beforeEach(() => {
  for (const fn of [...Object.values(api), toast.success, toast.error, onClose]) vi.mocked(fn).mockReset();
  api.fetchOAuthClientRoles.mockResolvedValue({
    roles: [admin, viewer],
    holders: [
      holder({ userId: 'u1', email: 'ada@example.test' }),
      holder({ userId: 'u2', name: 'Bob' }),
      holder({ userId: 'u3' }),
    ],
    holderCounts: { admin: 3 },
  });
});

describe('newRoleBlockedReason', () => {
  it('explains each block and clears for a valid new role', () => {
    const full = Array.from({ length: OAUTH_CLIENT_MAX_ROLES }, (_, i) => ({ key: `r${i}`, label: 'R' }));
    expect(newRoleBlockedReason({ key: 'x', label: 'X' }, full)).toMatch(/at most/);
    expect(newRoleBlockedReason({ key: '', label: 'X' }, [])).toBe('Role key is required');
    expect(newRoleBlockedReason({ key: 'admin', label: 'X' }, [admin])).toMatch(/already has a role "admin"/);
    expect(newRoleBlockedReason({ key: 'ops', label: 'Ops' }, [admin])).toBeNull();
  });
});

describe('OAuthClientRolesSection', () => {
  it('lists the roles with who holds each, by email, name or id', async () => {
    renderSection();
    expect(await screen.findByTestId('oauth-client-role-holders-admin')).toHaveTextContent('ada@example.test, Bob, u3');
    expect(screen.getByTestId('oauth-client-role-holders-viewer')).toHaveTextContent('-');
    expect(screen.getByTestId('oauth-client-roles-section')).toHaveTextContent('b4m_my_app_0011aabb');
    fireEvent.click(screen.getByTestId('oauth-client-roles-close-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  it('notes holders past the listed ones and counts them all on removal', async () => {
    api.fetchOAuthClientRoles.mockResolvedValue({
      roles: [admin],
      holders: [holder({ userId: 'u1', email: 'ada@example.test' })],
      holderCounts: { admin: 75 },
    });
    renderSection();
    expect(await screen.findByTestId('oauth-client-role-holders-admin')).toHaveTextContent(
      'ada@example.test and 74 more'
    );
    fireEvent.click(screen.getByTestId('oauth-client-role-actions-admin'));
    fireEvent.click(await screen.findByTestId('oauth-client-role-remove-admin'));
    expect(screen.getByTestId('oauth-client-role-remove-modal')).toHaveTextContent('75 people lose it');
  });

  it('shows an empty state that opens the add dialog', async () => {
    api.fetchOAuthClientRoles.mockResolvedValue({ roles: [], holders: [], holderCounts: {} });
    renderSection();
    fireEvent.click(await screen.findByTestId('oauth-client-role-empty-add-btn'));
    expect(screen.getByTestId('oauth-client-role-add-modal')).toBeInTheDocument();
  });

  it('shows the load error with a retry', async () => {
    api.fetchOAuthClientRoles.mockRejectedValueOnce(new Error('boom'));
    renderSection();
    expect(await screen.findByText(/Could not load roles: boom/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('oauth-client-role-holders-admin')).toBeInTheDocument();
  });

  it('adds a role with a reason, then refreshes and confirms', async () => {
    api.addOAuthClientRole.mockResolvedValue(client);
    renderSection();
    await screen.findByTestId('oauth-client-role-row-admin');
    fireEvent.click(screen.getByTestId('oauth-client-role-add-btn'));
    expect(screen.getByTestId('oauth-client-role-add-modal-confirm-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('oauth-client-role-key-input'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('oauth-client-role-label-input'), { target: { value: 'Operations' } });
    pickReason('add');
    fireEvent.click(screen.getByTestId('oauth-client-role-add-modal-confirm-btn'));

    await waitFor(() =>
      expect(api.addOAuthClientRole).toHaveBeenCalledWith('c1', {
        key: 'ops',
        label: 'Operations',
        reason: expect.any(String),
      })
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added the role ops to My App'));
    expect(screen.queryByTestId('oauth-client-role-add-modal')).not.toBeInTheDocument();
    expect(api.fetchOAuthClientRoles).toHaveBeenCalledTimes(2);
  });

  it('keeps the add dialog open and reports a failed add', async () => {
    api.addOAuthClientRole.mockRejectedValue(new Error('conflict'));
    renderSection();
    await screen.findByTestId('oauth-client-role-row-admin');
    fireEvent.click(screen.getByTestId('oauth-client-role-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-role-key-input'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('oauth-client-role-label-input'), { target: { value: 'Ops' } });
    pickReason('add');
    fireEvent.click(screen.getByTestId('oauth-client-role-add-modal-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('conflict'));
    expect(screen.getByTestId('oauth-client-role-add-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('oauth-client-role-add-modal-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-role-add-modal')).not.toBeInTheDocument());
  });

  it('removes a role, saying how many people lose it', async () => {
    api.removeOAuthClientRole.mockResolvedValue(client);
    renderSection();
    fireEvent.click(await screen.findByTestId('oauth-client-role-actions-admin'));
    fireEvent.click(await screen.findByTestId('oauth-client-role-remove-admin'));
    expect(screen.getByTestId('oauth-client-role-remove-modal')).toHaveTextContent('3 people lose it');
    pickReason('remove');
    fireEvent.click(screen.getByTestId('oauth-client-role-remove-modal-confirm-btn'));
    await waitFor(() => expect(api.removeOAuthClientRole).toHaveBeenCalledWith('c1', 'admin', expect.any(String)));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Removed the role admin from My App'));
    expect(screen.queryByTestId('oauth-client-role-remove-modal')).not.toBeInTheDocument();
  });

  it('says one person for a single holder, and reports a failed remove', async () => {
    api.fetchOAuthClientRoles.mockResolvedValue({
      roles: [admin],
      holders: [holder({ email: 'a@example.test' })],
      holderCounts: { admin: 1 },
    });
    api.removeOAuthClientRole.mockRejectedValue(new Error('gone'));
    renderSection();
    fireEvent.click(await screen.findByTestId('oauth-client-role-actions-admin'));
    fireEvent.click(await screen.findByTestId('oauth-client-role-remove-admin'));
    expect(screen.getByTestId('oauth-client-role-remove-modal')).toHaveTextContent('1 person loses it');
    pickReason('remove');
    fireEvent.click(screen.getByTestId('oauth-client-role-remove-modal-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('gone'));
    fireEvent.click(screen.getByTestId('oauth-client-role-remove-modal-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-role-remove-modal')).not.toBeInTheDocument());
  });
});
