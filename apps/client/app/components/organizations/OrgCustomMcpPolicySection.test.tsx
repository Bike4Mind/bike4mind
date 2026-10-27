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
  save: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@client/app/hooks/data/useOrgCustomMcpPolicy', () => ({
  useOrgCustomMcpPolicy: () => ({ data: state.view, isLoading: false }),
  useOrgCustomMcpConnections: () => ({ data: state.connections }),
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
});
