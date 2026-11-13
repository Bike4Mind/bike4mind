import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ORG_ALERT_KINDS, type OrgAlertKind } from '@bike4mind/common';
import type { MyOrgNotificationPrefs } from '@client/app/hooks/data/organizations';
import MyOrgNotificationPrefsCard from './MyOrgNotificationPrefsCard';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  prefs: undefined as MyOrgNotificationPrefs | undefined,
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useMyOrgNotificationPrefs: () => ({ data: mocks.prefs }),
  useUpdateMyOrgNotificationPrefs: () => ({ mutate: mocks.mutate, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const allKinds = (value: boolean) =>
  Object.fromEntries(ORG_ALERT_KINDS.map(kind => [kind, value])) as Record<OrgAlertKind, boolean>;
const toggle = (kind: OrgAlertKind) => screen.getByTestId(`org-alert-pref-${kind}-switch`) as HTMLInputElement;

describe('MyOrgNotificationPrefsCard', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.prefs = undefined;
  });

  it('renders nothing until prefs load', () => {
    render(<MyOrgNotificationPrefsCard organizationId="org1" />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('org-alert-prefs-card')).toBeNull();
  });

  it('shows a manager every kind off by default and opts in one kind at a time', () => {
    mocks.prefs = { role: 'manager', kinds: allKinds(false) };
    render(<MyOrgNotificationPrefsCard organizationId="org1" />, { wrapper: TestWrapper });
    for (const kind of ORG_ALERT_KINDS) expect(toggle(kind).checked).toBe(false);
    expect(screen.getByTestId('org-alert-prefs-card').textContent).toContain('Managers get no alerts');

    fireEvent.click(toggle('budget_threshold'));
    expect(mocks.mutate).toHaveBeenCalledWith({ organizationId: 'org1', kinds: { budget_threshold: true } });
  });

  it('lets the owner opt out of a kind', () => {
    mocks.prefs = { role: 'owner', kinds: allKinds(true) };
    render(<MyOrgNotificationPrefsCard organizationId="org1" />, { wrapper: TestWrapper });
    fireEvent.click(toggle('member_joined'));
    expect(mocks.mutate).toHaveBeenCalledWith({ organizationId: 'org1', kinds: { member_joined: false } });
  });
});
