import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MemberCreditBudgetNote } from './MemberCreditBudgetNote';

type Account = { id: string; personal: boolean };

const mocks = vi.hoisted(() => ({
  selectedAccount: null as Account | null,
  organization: undefined as unknown,
}));

vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: () => ({ selectedAccount: mocks.selectedAccount }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'viewer' } }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetOrganization: (id: string | null) => ({ data: id ? mocks.organization : undefined }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const orgWithUsage = (used: number, cap: number) => ({
  id: 'org1',
  name: 'Acme',
  maxCreditsPerMember: cap,
  userDetails: [{ id: 'viewer', maxCredits: null, usedCredits: used, periodStart: new Date().toISOString() }],
});

describe('MemberCreditBudgetNote', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    mocks.selectedAccount = { id: 'org1', personal: false };
    mocks.organization = orgWithUsage(450, 500);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows used and cap once the member nears the monthly limit', () => {
    render(<MemberCreditBudgetNote />, { wrapper: TestWrapper });
    const text = screen.getByTestId('member-credit-budget-note-text').textContent;
    expect(text).toContain('450');
    expect(text).toContain('500');
  });

  it('shows the exhausted state once the member has used the whole limit', () => {
    mocks.organization = orgWithUsage(500, 500);
    render(<MemberCreditBudgetNote />, { wrapper: TestWrapper });
    const text = screen.getByTestId('member-credit-budget-note-text').textContent;
    expect(text).toContain('500');
    expect(text).not.toContain('450');
  });

  it('hides after the dismiss button is clicked', () => {
    render(<MemberCreditBudgetNote />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('member-credit-budget-note-dismiss'));
    expect(screen.queryByTestId('session-member-credit-budget-note')).toBeNull();
  });

  it('is absent for a personal account', () => {
    mocks.selectedAccount = { id: 'personal', personal: true };
    render(<MemberCreditBudgetNote />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('session-member-credit-budget-note')).toBeNull();
  });
});
