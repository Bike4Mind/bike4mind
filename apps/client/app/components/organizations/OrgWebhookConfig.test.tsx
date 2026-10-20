import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument } from '@bike4mind/common';
import OrgWebhookConfig from './OrgWebhookConfig';

const { testMutateAsync, idleMutation } = vi.hoisted(() => ({
  testMutateAsync: vi.fn(),
  idleMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

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
  useUpdateOrgWebhookConfig: idleMutation,
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
