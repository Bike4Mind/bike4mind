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
  updateSubscription: vi.fn(),
  // Stable identity per enabled value: a fresh object each render re-triggers the form's sync effect forever.
  configs: {} as Record<string, object>,
  config(): object {
    const key = String(this.enabled);
    this.configs[key] ??= {
      id: 'jcfg-1',
      createdBy: 'user-1',
      enabled: this.enabled,
      webhookUrl: 'https://example.net/hook',
      secretMasked: 'abcd****',
    };
    return this.configs[key];
  },
}));

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock('@client/app/hooks/data/useJiraWebhooks', () => ({
  useGetJiraWebhookConfig: () => ({
    data: h.config(),
    isLoading: false,
    isError: false,
  }),
  useGetJiraWebhookSubscriptions: () => ({ data: h.subscriptions, isLoading: false }),
  useCreateJiraWebhookConfig: () => mutation,
  useUpdateJiraWebhookConfig: () => mutation,
  useDeleteJiraWebhookConfig: () => mutation,
  useCreateJiraWebhookSubscription: () => ({ ...mutation, mutateAsync: h.createSubscription }),
  useUpdateJiraWebhookSubscription: () => ({ ...mutation, mutateAsync: h.updateSubscription }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmationModal: { setState: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: h.currentUser }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

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

  it('does not report success when creating the subscription fails', async () => {
    h.createSubscription.mockRejectedValue(new Error('x'));
    renderForm();
    fireEvent.click(screen.getByTestId('jira-notifications-save'));
    await waitFor(() => expect(h.createSubscription).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('updates, not creates, when a subscription already exists', async () => {
    h.subscriptions = [{ id: 'sub-1', slackTarget: { type: 'dm' }, projectFilter: [], priorityFilter: [] }];
    h.updateSubscription.mockResolvedValue({});
    renderForm();
    fireEvent.click(screen.getByTestId('jira-notifications-save'));
    await waitFor(() => expect(h.updateSubscription).toHaveBeenCalledTimes(1));
    expect(h.updateSubscription.mock.calls[0][0]).toMatchObject({ id: 'sub-1' });
    expect(h.createSubscription).not.toHaveBeenCalled();
  });

  it('hides the off alert from the creator and an admin on a disabled config', () => {
    h.enabled = false;
    h.currentUser = { id: 'user-1', isAdmin: false };
    const creator = renderForm();
    expect(screen.queryByTestId('jira-notifications-off-alert')).toBeNull();
    creator.unmount();

    h.currentUser = { id: 'admin-1', isAdmin: true };
    renderForm();
    expect(screen.queryByTestId('jira-notifications-off-alert')).toBeNull();
  });

  it('disables the inputs for a non-manager on a disabled config only', () => {
    h.enabled = false;
    h.currentUser = { id: 'user-2', isAdmin: false };
    const other = renderForm();
    for (const id of ['jira-slack-channel-id', 'jira-project-filter']) {
      expect(
        screen.getByTestId(id).querySelector('input')?.disabled ?? (screen.getByTestId(id) as HTMLInputElement).disabled
      ).toBe(true);
    }
    other.unmount();

    h.currentUser = { id: 'user-1', isAdmin: false };
    renderForm();
    for (const id of ['jira-slack-channel-id', 'jira-project-filter']) {
      expect(
        screen.getByTestId(id).querySelector('input')?.disabled ?? (screen.getByTestId(id) as HTMLInputElement).disabled
      ).toBe(false);
    }
  });
});
