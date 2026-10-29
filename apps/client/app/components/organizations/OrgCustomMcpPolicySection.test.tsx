import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CustomMcpPolicySchema, type IOrganizationDocument, type OrgCustomMcpPolicyView } from '@bike4mind/common';
import OrgCustomMcpPolicySection from './OrgCustomMcpPolicySection';

const state = vi.hoisted(() => ({
  view: undefined as OrgCustomMcpPolicyView | undefined,
  connections: [] as Record<string, unknown>[],
  policyError: false,
  connectionsPending: false,
  connectionsError: false,
  refetchPolicy: vi.fn(),
  refetchConnections: vi.fn(),
  save: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@client/app/hooks/data/useOrgCustomMcpPolicy', () => ({
  useOrgCustomMcpPolicy: () => ({
    data: state.view,
    isLoading: false,
    isError: state.policyError,
    refetch: state.refetchPolicy,
  }),
  useOrgCustomMcpConnections: () => ({
    data: state.connections,
    isPending: state.connectionsPending,
    isError: state.connectionsError,
    refetch: state.refetchConnections,
  }),
  useSaveOrgCustomMcpPolicy: () => ({ mutate: state.save, isPending: false }),
  useResetOrgCustomMcpPolicy: () => ({ mutate: state.reset, isPending: false }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: [{ id: 'u1', name: 'Ada' }] }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderSection = () =>
  render(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />, {
    wrapper: TestWrapper,
  });

const viewOf = (overrides: Partial<OrgCustomMcpPolicyView> = {}, policy = {}): OrgCustomMcpPolicyView => ({
  policy: CustomMcpPolicySchema.parse({ mode: 'allowlist', allowedHostPatterns: ['mcp.example.com'], ...policy }),
  overridden: true,
  invalidOverride: false,
  platformEnabled: true,
  ...overrides,
});

const toggle = (testId: string) => fireEvent.click(within(screen.getByTestId(testId)).getByRole('switch'));
const saveButton = () => screen.getByTestId('org-custom-mcp-save-btn') as HTMLButtonElement;

describe('OrgCustomMcpPolicySection', () => {
  beforeEach(() => {
    state.view = viewOf();
    state.connections = [];
    state.policyError = false;
    state.connectionsPending = false;
    state.connectionsError = false;
    state.refetchPolicy.mockReset();
    state.refetchConnections.mockReset();
    state.save.mockReset();
    state.reset.mockReset();
  });

  it('saves mode off when the kill switch is turned off, keeping the rest of the policy', () => {
    renderSection();
    expect(saveButton().disabled).toBe(true);

    toggle('org-custom-mcp-enabled-switch');
    fireEvent.click(saveButton());

    expect(state.save).toHaveBeenCalledWith(
      CustomMcpPolicySchema.parse({ mode: 'off', allowedHostPatterns: ['mcp.example.com'] })
    );
  });

  it('saves requireApprovalForAll', () => {
    renderSection();
    toggle('org-custom-mcp-require-approval-switch');
    fireEvent.click(saveButton());
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ requireApprovalForAll: true }));
  });

  it('turning connectors back on restores an open mode', () => {
    state.view = viewOf({}, { mode: 'off' });
    renderSection();
    toggle('org-custom-mcp-enabled-switch');
    fireEvent.click(saveButton());
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ mode: 'presets_only' }));
  });

  it('will not save a connection limit above the platform cap', () => {
    renderSection();
    fireEvent.change(within(screen.getByTestId('org-custom-mcp-max-connections')).getByRole('spinbutton'), {
      target: { value: '500' },
    });
    expect(saveButton().disabled).toBe(true);
  });

  it('resets to the platform default only when the org has an override', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('org-custom-mcp-reset-btn'));
    expect(state.reset).toHaveBeenCalled();

    state.view = viewOf({ overridden: false });
    renderSection();
    expect((screen.getAllByTestId('org-custom-mcp-reset-btn')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads the platform default after resetting a policy with unsaved edits', () => {
    const { rerender } = renderSection();
    toggle('org-custom-mcp-require-approval-switch');

    const platformView = viewOf({ overridden: false }, { mode: 'any' });
    state.reset.mockImplementation(
      (_input: undefined, options: { onSuccess: (view: OrgCustomMcpPolicyView) => void }) => {
        state.view = platformView;
        options.onSuccess(platformView);
      }
    );
    fireEvent.click(screen.getByTestId('org-custom-mcp-reset-btn'));
    rerender(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />);

    expect(screen.queryByTestId('org-custom-mcp-changed-elsewhere')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(
      (within(screen.getByTestId('org-custom-mcp-require-approval-switch')).getByRole('switch') as HTMLInputElement)
        .checked
    ).toBe(false);
    expect(screen.getByTestId('org-custom-mcp-mode-select').textContent).toContain('Any host');
  });

  it('shows a failed policy read with a retry instead of an endless spinner', () => {
    state.view = undefined;
    state.policyError = true;
    renderSection();

    expect(screen.getByText('Could not load the connector policy.')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('org-custom-mcp-policy-error')).getByText('Retry'));
    expect(state.refetchPolicy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('keeps pending connection reads distinct from an empty roster', () => {
    state.connectionsPending = true;
    renderSection();

    expect(screen.getByTestId('org-custom-mcp-connections-loading')).toBeTruthy();
    expect(screen.queryByTestId('org-custom-mcp-connections-empty')).toBeNull();
  });

  it('shows failed connection reads with a retry instead of an empty roster', () => {
    state.connectionsError = true;
    renderSection();

    expect(screen.getByText('Could not load member connections.')).toBeTruthy();
    expect(screen.queryByTestId('org-custom-mcp-connections-empty')).toBeNull();
    fireEvent.click(within(screen.getByTestId('org-custom-mcp-connections-error')).getByText('Retry'));
    expect(state.refetchConnections).toHaveBeenCalledOnce();
  });

  it('warns when the platform switch is off or the stored policy is invalid', () => {
    state.view = viewOf({ platformEnabled: false, invalidOverride: true });
    renderSection();
    expect(screen.getByTestId('org-custom-mcp-platform-off')).toBeTruthy();
    expect(screen.getByTestId('org-custom-mcp-invalid')).toBeTruthy();
  });

  it('keeps unsaved edits when the policy changes elsewhere, and offers to load the latest', () => {
    const { rerender } = renderSection();
    toggle('org-custom-mcp-require-approval-switch');

    state.view = viewOf({}, { mode: 'any' });
    rerender(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />);
    expect(screen.getByTestId('org-custom-mcp-changed-elsewhere')).toBeTruthy();
    fireEvent.click(saveButton());
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'allowlist', requireApprovalForAll: true })
    );

    fireEvent.click(screen.getByText('Load latest'));
    expect(screen.queryByTestId('org-custom-mcp-changed-elsewhere')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('takes a newer policy as is when there are no unsaved edits, and after its own save', () => {
    const { rerender } = renderSection();
    state.view = viewOf({}, { mode: 'any' });
    rerender(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />);
    expect(screen.queryByTestId('org-custom-mcp-changed-elsewhere')).toBeNull();

    toggle('org-custom-mcp-require-approval-switch');
    state.view = viewOf({}, { mode: 'any', requireApprovalForAll: true });
    rerender(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />);
    expect(screen.queryByTestId('org-custom-mcp-changed-elsewhere')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('lists member connections by member name with their policy status', () => {
    state.connections = [
      { id: 'c1', displayName: 'Linear', urlHost: 'mcp.linear.app', userId: 'u1', status: 'blocked_by_policy' },
    ];
    renderSection();
    const table = screen.getByTestId('org-custom-mcp-connections-table');
    expect(within(table).getByText('Ada')).toBeTruthy();
    expect(within(table).getByText('blocked_by_policy')).toBeTruthy();
  });

  it('pages member connections and clamps the page after connections are removed', () => {
    state.connections = Array.from({ length: 21 }, (_, index) => ({
      id: `connection-${index}`,
      displayName: `Connector ${index + 1}`,
      urlHost: 'mcp.example.com',
      userId: 'u1',
      status: 'connected',
    }));
    const { rerender } = renderSection();
    const table = screen.getByTestId('org-custom-mcp-connections-table');
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(within(table).queryByText('Connector 21')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Connector 21')).toBeTruthy();
    expect(within(table).queryByText('Connector 1')).toBeNull();

    state.connections = state.connections.slice(0, 1);
    rerender(<OrgCustomMcpPolicySection organization={{ id: 'org-1' } as IOrganizationDocument} />);
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    expect(within(table).getByText('Connector 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
