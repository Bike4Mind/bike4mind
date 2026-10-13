// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ currentUser: { id: 'user-2', isAdmin: false } as { id: string; isAdmin?: boolean } }));

const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock('@client/app/hooks/data/useJiraWebhooks', () => ({
  useGetJiraWebhookConfig: () => ({
    data: {
      id: 'jcfg-1',
      createdBy: 'user-1',
      enabled: true,
      webhookUrl: 'https://example.net/hook',
      secretMasked: 'abcd****',
    },
    isLoading: false,
    isError: false,
  }),
  useGetJiraWebhookSubscriptions: () => ({ data: [], isLoading: false }),
  useCreateJiraWebhookConfig: () => mutation,
  useUpdateJiraWebhookConfig: () => mutation,
  useDeleteJiraWebhookConfig: () => mutation,
  useCreateJiraWebhookSubscription: () => mutation,
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
});
