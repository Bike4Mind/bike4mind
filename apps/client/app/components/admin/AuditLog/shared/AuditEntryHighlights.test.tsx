import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import { findApiKeyScopeOption } from '@client/app/constants/apiKeyScopes';
import { AuditEventTable } from './AuditEventTable';
import { makeAuditEntry } from './auditTestFixtures';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ADMIN = {
  kind: 'user' as const,
  scope: 'platform' as const,
  userId: 'admin-1',
  name: 'Alice Admin',
  wasAdmin: true,
};

const keyEntry = (overrides: Parameters<typeof makeAuditEntry>[0] = {}) =>
  makeAuditEntry({
    action: 'user.api_key.generated',
    category: 'access',
    severity: 'critical',
    summary: 'generated API key b4m_live_abc for user',
    details: { keyId: 'k1', keyPrefix: 'b4m_live_abc', name: 'Rewards bot', scopes: [ApiKeyScope.REWARDS_GRANT] },
    ...overrides,
  });

const renderTable = (entries: ReturnType<typeof makeAuditEntry>[]) =>
  render(
    <AuditEventTable
      entries={entries}
      isLoading={false}
      hasMore={false}
      isFetchingMore={false}
      onLoadMore={vi.fn()}
      onSelectEntry={vi.fn()}
      testIdPrefix="audit-needs-review-table"
    />,
    { wrapper: TestWrapper }
  );

describe('AuditEventTable - API key and self-targeted highlights', () => {
  it('shows the key name and spells out what an admin-provisioned scope can do', () => {
    renderTable([keyEntry()]);
    const row = screen.getByTestId('audit-needs-review-table-row-entry-1');

    expect(within(row).getByTestId('audit-needs-review-table-key-name')).toHaveTextContent('Key "Rewards bot"');
    expect(
      within(row).getByTestId(`audit-needs-review-table-key-scope-${ApiKeyScope.REWARDS_GRANT}`)
    ).toHaveTextContent('Partners: Rewards');
    // Read from the scope catalogue, so the row and the key dialog never describe a scope differently.
    const description = findApiKeyScopeOption(ApiKeyScope.REWARDS_GRANT)?.description;
    expect(description).toMatch(/grant credits to users/i);
    expect(
      within(row).getByTestId(`audit-needs-review-table-key-scope-description-${ApiKeyScope.REWARDS_GRANT}`)
    ).toHaveTextContent(`Partners: Rewards: ${description}`);
  });

  it('labels self-service scopes without a description line', () => {
    renderTable([keyEntry({ details: { name: 'Reader', scopes: [ApiKeyScope.READ_NOTEBOOKS] } })]);
    expect(screen.getByTestId(`audit-needs-review-table-key-scope-${ApiKeyScope.READ_NOTEBOOKS}`)).toHaveTextContent(
      'Read Notebooks'
    );
    expect(
      screen.queryByTestId(`audit-needs-review-table-key-scope-description-${ApiKeyScope.READ_NOTEBOOKS}`)
    ).toBeNull();
  });

  it('reads the keyName the rotate and revoke entries record, and falls back to the raw value for an unknown scope', () => {
    renderTable([
      keyEntry({ action: 'user.api_key.rotated', details: { keyName: 'CI key', scopes: ['legacy:scope'] } }),
    ]);
    expect(screen.getByTestId('audit-needs-review-table-key-name')).toHaveTextContent('Key "CI key"');
    expect(screen.getByTestId('audit-needs-review-table-key-scope-legacy:scope')).toHaveTextContent('legacy:scope');
  });

  it('renders no key details for a key entry that recorded neither name nor scopes, or a non-key entry', () => {
    renderTable([
      keyEntry({ id: 'entry-old', details: { keyId: 'k1' } }),
      makeAuditEntry({ id: 'entry-credits', details: { name: 'not a key' } }),
    ]);
    expect(screen.queryByTestId('audit-needs-review-table-key-details')).toBeNull();
  });

  it('marks a critical entry the admin performed on their own account', () => {
    renderTable([
      keyEntry({ actor: ADMIN, target: { kind: 'user', id: 'ADMIN-1', displayName: 'Alice Admin' } }),
      keyEntry({ id: 'entry-other', actor: ADMIN }),
    ]);
    const selfRow = screen.getByTestId('audit-needs-review-table-row-entry-1');
    const otherRow = screen.getByTestId('audit-needs-review-table-row-entry-other');
    expect(within(selfRow).getByTestId('audit-needs-review-table-self-targeted-chip')).toHaveTextContent(
      'Self-targeted'
    );
    expect(within(otherRow).queryByTestId('audit-needs-review-table-self-targeted-chip')).toBeNull();
  });

  it('marks any self-targeted critical entry, not only API keys, and leaves non-critical ones alone', () => {
    renderTable([
      makeAuditEntry({
        id: 'entry-role',
        action: 'user.role.changed',
        severity: 'critical',
        target: { kind: 'user', id: 'admin-1', displayName: 'Alice Admin' },
      }),
      makeAuditEntry({
        id: 'entry-notice',
        severity: 'notice',
        target: { kind: 'user', id: 'admin-1', displayName: 'Alice Admin' },
      }),
    ]);
    expect(
      within(screen.getByTestId('audit-needs-review-table-row-entry-role')).getByTestId(
        'audit-needs-review-table-self-targeted-chip'
      )
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('audit-needs-review-table-row-entry-notice')).queryByTestId(
        'audit-needs-review-table-self-targeted-chip'
      )
    ).toBeNull();
  });

  it('shows the recorded reason on an admin-provisioned key entry', () => {
    renderTable([keyEntry({ reason: 'Partner integration: game server' })]);
    expect(screen.getByTestId('audit-needs-review-table-reason')).toHaveTextContent('Partner integration: game server');
  });
});
