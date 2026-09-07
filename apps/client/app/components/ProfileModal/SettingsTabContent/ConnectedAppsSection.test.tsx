import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// What matters here is the DISCONNECT GATE, not the layout. Unlinking Google Drive revokes the OAuth
// grant at Google, which the user can only undo with a fresh consent round-trip, so a single stray
// click must not do it - and the integrations that opted out must stay one click.
const h = vi.hoisted(() => ({
  disconnectDrive: vi.fn(),
  connectDrive: vi.fn(),
  disconnectAtlassian: vi.fn(),
  refreshUser: vi.fn(),
  confirm: vi.fn(),
  toastWarning: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('sonner', () => ({
  toast: { warning: h.toastWarning, success: h.toastSuccess, error: h.toastError },
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), delete: vi.fn() } }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => h.confirm }));

let currentUser: Record<string, unknown> = { id: 'u1', googleDrive: { expiresAt: '2099-01-01' } };
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: Record<string, unknown>) => unknown) => selector({ currentUser, refreshUser: h.refreshUser }),
}));

vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useConnectGoogleDrive: () => ({ mutate: h.connectDrive, isPending: false }),
  useDisconnectGoogleDrive: () => ({ mutate: h.disconnectDrive, isPending: false }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useConnectAtlassian: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectAtlassian: () => ({ mutate: h.disconnectAtlassian, isPending: false }),
  useConnectNotion: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectNotion: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotionSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import ConnectedAppsSection from './ConnectedAppsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ConnectedAppsSection />
    </CssVarsProvider>
  );

/**
 * The card for a named integration. Filters to the match that actually sits inside a card: the jsdom
 * document <title> is also "Google Drive", so a bare getByText finds two nodes.
 */
const card = (name: string): HTMLElement => {
  const el = screen
    .getAllByText(name)
    .map(n => n.closest('.connected-app-container'))
    .find(Boolean);
  if (!el) throw new Error(`no connected-app card named "${name}"`);
  return el as HTMLElement;
};
const cardButton = (name: string, label: RegExp) => within(card(name)).getByRole('button', { name: label });

/** Run the confirm dialog's onOk - i.e. the user pressing Disconnect in the modal. */
const acceptConfirm = async () => {
  const opts = h.confirm.mock.calls[0][0] as { onOk: () => void | Promise<void> };
  await opts.onOk();
};

describe('ConnectedAppsSection - Google Drive disconnect gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: 'u1', googleDrive: { expiresAt: '2099-01-01' } };
  });

  it('asks for confirmation instead of disconnecting immediately', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));

    // A single click must never revoke the grant.
    expect(h.disconnectDrive).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ type: 'danger' });
  });

  it('names the real consequences in the dialog, including that it is recoverable', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));

    const { description } = h.confirm.mock.calls[0][0] as { description: string };
    expect(description).toMatch(/revokes/i);
    // The org-sync consequence is the whole reason this dialog exists.
    expect(description).toMatch(/organization Drive folder sync/i);
    // Without this the copy reads as permanent, and scarier than the truth.
    expect(description).toMatch(/link Google Drive again/i);
  });

  it('disconnects once the user accepts the dialog', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    expect(h.disconnectDrive).toHaveBeenCalledTimes(1);
  });

  it('leaves integrations that did not opt in on a single click', async () => {
    const user = userEvent.setup();
    currentUser = {
      id: 'u1',
      googleDrive: { expiresAt: '2099-01-01' },
      atlassianConnect: { status: 'connected', siteName: 'acme' },
    };
    renderSection();

    await user.click(cardButton('Atlassian (Jira, Confluence)', /unlink/i));

    // Opt-in per integration: none of the siblings provably revokes a third-party grant today, so
    // adding friction there would be an unrelated behaviour change.
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.disconnectAtlassian).toHaveBeenCalledTimes(1);
  });

  it('warns with singular grammar when exactly one org sync is affected', async () => {
    const user = userEvent.setup();
    h.disconnectDrive.mockImplementation((_v: unknown, opts: { onSuccess: (n: number) => void }) => opts.onSuccess(1));
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    await waitFor(() => expect(h.toastWarning).toHaveBeenCalled());
    expect(h.toastWarning.mock.calls[0][0]).toMatch(/1 organization Drive folder sync .*needs reconnecting/);
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('uses plural grammar for more than one affected sync', async () => {
    const user = userEvent.setup();
    h.disconnectDrive.mockImplementation((_v: unknown, opts: { onSuccess: (n: number) => void }) => opts.onSuccess(3));
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    await waitFor(() => expect(h.toastWarning).toHaveBeenCalled());
    expect(h.toastWarning.mock.calls[0][0]).toMatch(/3 organization Drive folder syncs .*need reconnecting/);
  });

  it('shows a plain success (no warning) when nothing else was affected', async () => {
    const user = userEvent.setup();
    h.disconnectDrive.mockImplementation((_v: unknown, opts: { onSuccess: (n: number) => void }) => opts.onSuccess(0));
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastWarning).not.toHaveBeenCalled();
  });

  it('refreshes the user so the card reflects the disconnect without a reload', async () => {
    const user = userEvent.setup();
    h.disconnectDrive.mockImplementation((_v: unknown, opts: { onSuccess: (n: number) => void }) => opts.onSuccess(0));
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    // The card reads the zustand currentUser; only an /api/identify round-trip rewrites it, so a
    // React Query invalidation alone leaves it reading "Unlink" after a successful disconnect.
    await waitFor(() => expect(h.refreshUser).toHaveBeenCalled());
  });

  it('surfaces a failed disconnect instead of failing silently', async () => {
    const user = userEvent.setup();
    h.disconnectDrive.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new Error('boom'))
    );
    renderSection();

    await user.click(cardButton('Google Drive', /unlink/i));
    await acceptConfirm();

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
  });
});
