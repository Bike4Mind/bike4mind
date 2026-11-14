import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument } from '@bike4mind/common';
import OrgWebhookConfig from './OrgWebhookConfig';

const { testMutateAsync, updateMutateAsync, idleMutation, updatePending, savedEvents } = vi.hoisted(() => ({
  savedEvents: { current: [] as string[] },
  updatePending: { current: false },
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
      subscribedEvents: savedEvents.current,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCreateOrgWebhookConfig: idleMutation,
  useUpdateOrgWebhookConfig: () => ({ mutateAsync: updateMutateAsync, isPending: updatePending.current }),
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

beforeEach(() => {
  savedEvents.current = [];
});

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

  it('shows, removes and restores saved custom events without silently changing the payload', async () => {
    savedEvents.current = ['push', 'check_run'];
    renderConfig();
    const custom = () => screen.getByTestId('webhook-event-chip-check_run');
    expect(custom()).toHaveTextContent('check_run');
    expect(screen.getByText('2 of 9 event(s) selected. Click events to toggle.')).toBeInTheDocument();
    expect(custom()).toHaveClass('MuiChip-variantSolid');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    pickEvent('check_run');
    expect(custom()).toHaveClass('MuiChip-variantOutlined');
    expect(updateMutateAsync).not.toHaveBeenCalled();
    pickEvent('check_run');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    pickEvent('check_run');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(custom()).toHaveClass('MuiChip-variantSolid');
    pickEvent('check_run');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        orgId: 'org-1',
        data: { subscribedEvents: ['push'] },
      })
    );
  });

  it('preserves a saved custom event when changing an unrelated known event', async () => {
    savedEvents.current = ['push', 'check_run'];
    renderConfig();
    pickEvent('issues');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() =>
      expect(updateMutateAsync).toHaveBeenCalledWith({
        orgId: 'org-1',
        data: { subscribedEvents: ['push', 'check_run', 'issues'] },
      })
    );
  });

  it('retains a failed custom-event draft until Discard, without treating it as saved', async () => {
    savedEvents.current = ['push', 'check_run'];
    updateMutateAsync.mockRejectedValueOnce(new Error('Save failed'));
    renderConfig();
    pickEvent('check_run');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('admin-save-discard-btn')).not.toBeDisabled());
    expect(updateMutateAsync).toHaveBeenCalledWith({ orgId: 'org-1', data: { subscribedEvents: ['push'] } });
    expect(screen.getByTestId('admin-save-bar')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-event-chip-check_run')).toHaveClass('MuiChip-variantOutlined');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.getByTestId('webhook-event-chip-check_run')).toHaveClass('MuiChip-variantSolid');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
  });

  it('retains the empty-as-all safety guard when the last custom event is removed', () => {
    savedEvents.current = ['check_run'];
    renderConfig();
    pickEvent('check_run');
    expect(screen.getByTestId('webhook-event-chip-check_run')).toBeInTheDocument();
    expect(screen.getByTestId('admin-save-confirm-btn')).toBeDisabled();
    expect(screen.getByText('Select at least one event.')).toBeInTheDocument();
    expect(updateMutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
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

  it('shows the save bar as saving only while the events save is in flight, not for the Enabled toggle', async () => {
    let finish: () => void = () => undefined;
    updateMutateAsync.mockReturnValue(new Promise<void>(resolve => (finish = resolve)));
    try {
      renderConfig();
      pickEvent('push');
      updatePending.current = true;
      pickEvent('pull_request');
      expect(screen.getByTestId('admin-save-discard-btn').hasAttribute('disabled')).toBe(false);

      fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
      await waitFor(() => expect(screen.getByTestId('admin-save-discard-btn').hasAttribute('disabled')).toBe(true));
      finish();
      await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    } finally {
      updatePending.current = false;
    }
  });
});
