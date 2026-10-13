// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  currentUser: { id: 'user-2', isAdmin: false } as { id: string; isAdmin?: boolean },
  enabled: true,
  subscriptions: [] as unknown[],
  createSubscription: vi.fn(),
}));

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock('@client/app/hooks/data/useJiraWebhooks', () => ({
  useGetJiraWebhookConfig: () => ({
    data: {
      id: 'jcfg-1',
      createdBy: 'user-1',
      enabled: h.enabled,
      webhookUrl: 'https://example.net/hook',
      secretMasked: 'abcd****',
    },
    isLoading: false,
    isError: false,
  }),
  useGetJiraWebhookSubscriptions: () => ({ data: h.subscriptions, isLoading: false }),
  useCreateJiraWebhookConfig: () => mutation,
  useUpdateJiraWebhookConfig: () => mutation,
  useDeleteJiraWebhookConfig: () => mutation,
  useCreateJiraWebhookSubscription: () => ({ ...mutation, mutateAsync: h.createSubscription }),
  useUpdateJiraWebhookSubscription: () => mutation,
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmationModal: { setState: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: h.currentUser }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import JiraNotificationsForm from './JiraNotificationsForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderForm = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <JiraNotificationsForm />
    </CssVarsProvider>
  );

describe('JiraNotificationsForm secret controls', () => {
  afterEach(() => {
    cleanup();
    h.enabled = true;
    h.subscriptions = [];
    h.currentUser = { id: 'user-2', isAdmin: false };
    vi.clearAllMocks();
  });

  it('shows reveal and copy controls only to the config creator or an admin', () => {
    h.currentUser = { id: 'user-2', isAdmin: false };
    const other = renderForm();
    expect(screen.queryByTestId('toggle-jira-secret-visibility')).toBeNull();
    expect(screen.queryByTestId('copy-jira-secret')).toBeNull();
    expect(screen.getByDisplayValue('abcd****')).toBeTruthy();
    other.unmount();

    h.currentUser = { id: 'user-1', isAdmin: false };
    const creator = renderForm();
    expect(screen.getByTestId('toggle-jira-secret-visibility')).toBeTruthy();
    expect(screen.getByTestId('copy-jira-secret')).toBeTruthy();
    creator.unmount();

    h.currentUser = { id: 'admin-1', isAdmin: true };
    renderForm();
    expect(screen.getByTestId('toggle-jira-secret-visibility')).toBeTruthy();
  });

  it('shows Enable, Disable and Delete only to the config creator or an admin', () => {
    const testIds = ['jira-notifications-disable', 'jira-notifications-delete'];

    h.currentUser = { id: 'user-2', isAdmin: false };
    const other = renderForm();
    for (const id of testIds) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId('jira-notifications-save')).toBeTruthy();
    other.unmount();

    h.currentUser = { id: 'user-1', isAdmin: false };
    const creator = renderForm();
    for (const id of testIds) expect(screen.getByTestId(id)).toBeTruthy();
    creator.unmount();

    h.currentUser = { id: 'admin-1', isAdmin: true };
    renderForm();
    for (const id of testIds) expect(screen.getByTestId(id)).toBeTruthy();
  });

  it('creates the caller own subscription on save when none exists yet', async () => {
    h.createSubscription.mockResolvedValue({});
    renderForm();
    fireEvent.click(screen.getByTestId('jira-notifications-save'));
    await waitFor(() => expect(h.createSubscription).toHaveBeenCalledTimes(1));
    expect(h.createSubscription.mock.calls[0][0]).toMatchObject({ webhookConfigId: 'jcfg-1' });
  });

  it('on a disabled config shows Enable only to someone who can manage it', () => {
    h.enabled = false;
    h.currentUser = { id: 'user-2', isAdmin: false };
    const other = renderForm();
    expect(screen.queryByTestId('jira-notifications-save')).toBeNull();
    expect(screen.getByTestId('jira-notifications-off-alert')).toBeTruthy();
    other.unmount();

    h.currentUser = { id: 'user-1', isAdmin: false };
    renderForm();
    expect(screen.getByTestId('jira-notifications-save').textContent).toBe('Enable Notifications');
  });
});
