import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument } from '@bike4mind/common';
import OrgWebhookConfig from './OrgWebhookConfig';

const { testMutateAsync, updateMutateAsync, idleMutation } = vi.hoisted(() => ({
  testMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  idleMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-router', () => ({ useBlocker: () => ({ status: 'idle' }) }));
vi.mock('@client/app/hooks/data/useOrgWebhooks', () => ({
  useGetOrgWebhookConfig: () => ({
    data: {
      organizationId: 'org-1',
      enabled: true,
      webhookUrl: 'https://app.example.com/api/webhooks/github/org-1',
      secretMasked: '****',
      subscribedEvents: [],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateOrgWebhookConfig: idleMutation,
  useUpdateOrgWebhookConfig: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  useDeleteOrgWebhookConfig: idleMutation,
  useRotateOrgWebhookSecret: idleMutation,
  useTestOrgWebhook: () => ({ mutateAsync: testMutateAsync, isPending: false }),
  useReplayDLQ: idleMutation,
}));

vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmationModal: { setState: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderConfig = () =>
  render(<OrgWebhookConfig organization={{ id: 'org-1' } as IOrganizationDocument} />, { wrapper: TestWrapper });

const testButton = () => screen.getByTestId('test-webhook') as HTMLButtonElement;

describe('OrgWebhookConfig test ping', () => {
  beforeEach(() => {
    testMutateAsync.mockReset().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 12 });
  });

  it('keeps Send Test Ping disabled until a target URL is entered', () => {
    renderConfig();
    expect(testButton().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('test-webhook-target-url'), { target: { value: '   ' } });
    expect(testButton().disabled).toBe(true);
  });

  it('sends the trimmed target URL with the ping', () => {
    renderConfig();
    fireEvent.change(screen.getByTestId('test-webhook-target-url'), {
      target: { value: '  https://hooks.example.com/ping  ' },
    });
    fireEvent.click(testButton());

    expect(testMutateAsync).toHaveBeenCalledWith({ orgId: 'org-1', targetUrl: 'https://hooks.example.com/ping' });
  });
});

// A clickable Joy Chip puts its click target on an inner button, not the root.
const pickEvent = (event: string) =>
  fireEvent.click(within(screen.getByTestId(`webhook-event-chip-${event}`)).getByRole('button'));

describe('OrgWebhookConfig subscribed events', () => {
  beforeEach(() => {
    updateMutateAsync.mockReset().mockResolvedValue({});
  });

  it('stages event picks behind the save bar and saves them together', async () => {
    renderConfig();
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();

    pickEvent('push');
    pickEvent('pull_request');
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('2 unsaved changes');
    expect(updateMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(updateMutateAsync).toHaveBeenCalledWith({
      orgId: 'org-1',
      data: { subscribedEvents: ['push', 'pull_request'] },
    });
  });

  it('drops staged picks on Discard', () => {
    renderConfig();
    pickEvent('push');

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });
});
