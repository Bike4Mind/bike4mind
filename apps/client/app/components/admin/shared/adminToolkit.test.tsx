import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import {
  AdminPageHeader,
  EntityHeader,
  Fact,
  Kbd,
  RelativeTime,
  formatUtc,
  StatStrip,
  StatTile,
  SectionCard,
  StatusChip,
  EmptyState,
  ErrorState,
  BulkActionBar,
  type AdminSelection,
} from './index';

const theme = extendTheme({ ...getThemeConfig() });
const renderToolkit = (children: ReactNode) => render(<CssVarsProvider theme={theme}>{children}</CssVarsProvider>);

describe('admin layout primitives', () => {
  it('renders page identity, count, description and actions', () => {
    renderToolkit(
      <AdminPageHeader
        title="Accounts"
        count={1200}
        description="Manage access"
        actions={<button data-testid="create-account">Create account</button>}
      />
    );
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Accounts (1,200)');
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Manage access');
    expect(screen.getByTestId('create-account')).toBeVisible();
  });

  it('renders statistic values, comparisons and optional sparklines', () => {
    renderToolkit(
      <StatStrip>
        <StatTile
          label="Requests"
          value={1200}
          comparison="+20 today"
          sparkline={<svg data-testid="sparkline" aria-label="Requests trend" />}
        />
      </StatStrip>
    );
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('Requests1,200+20 today');
    expect(screen.getByTestId('sparkline')).toBeVisible();
  });

  it('puts a help control beside a stat label', () => {
    renderToolkit(
      <StatStrip>
        <StatTile label="MRR" help={<button data-testid="mrr-help-btn">About MRR</button>} value="$19.00" />
      </StatStrip>
    );
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('MRRAbout MRR$19.00');
    expect(screen.getByTestId('mrr-help-btn')).toBeVisible();
  });

  it('groups facts under a section heading with an action', () => {
    renderToolkit(
      <SectionCard title="Access" action={<button data-testid="view-audit">View audit</button>}>
        <dt>Role</dt>
        <dd>Admin</dd>
      </SectionCard>
    );
    expect(screen.getByTestId('admin-section-card')).toHaveTextContent('AccessView auditRoleAdmin');
    expect(screen.getByTestId('view-audit')).toBeVisible();
  });

  it.each(['good', 'info', 'warn', 'bad', 'neutral'] as const)('gives %s status a text label', tone => {
    renderToolkit(<StatusChip tone={tone} label="Account status" />);
    expect(screen.getByTestId('admin-status-chip')).toHaveTextContent('Account status');
    expect(screen.getByTestId('admin-status-chip')).toHaveAttribute('data-tone', tone);
  });

  it('lets a status chip take its own test id and show a dot', () => {
    renderToolkit(<StatusChip tone="good" label="Active" dot data-testid="custom-chip" />);
    expect(screen.getByTestId('custom-chip')).toHaveTextContent('Active');
    expect(screen.queryByTestId('admin-status-chip')).not.toBeInTheDocument();
  });

  it('labels the stat strip and renders a custom aria-label', () => {
    renderToolkit(
      <StatStrip aria-label="Account at a glance">
        <StatTile label="Credits" value="3" />
      </StatStrip>
    );
    expect(screen.getByRole('region', { name: 'Account at a glance' })).toBeInTheDocument();
  });

  it('uses a custom test id on a section card and shows a dash for an empty fact', () => {
    renderToolkit(
      <SectionCard title="Identity" data-testid="identity-card">
        <Fact label="Name" data-testid="fact-name">
          Ada
        </Fact>
        <Fact label="Plan" data-testid="fact-plan" />
      </SectionCard>
    );
    expect(screen.getByTestId('identity-card')).toHaveTextContent('Identity');
    expect(screen.getByTestId('fact-name')).toHaveTextContent('Ada');
    expect(screen.getByTestId('fact-plan')).toHaveTextContent('-');
  });

  it('hands a custom section body over without a definition list', () => {
    renderToolkit(
      <SectionCard title="Balance" body="custom">
        <div data-testid="custom-body" />
      </SectionCard>
    );
    expect(screen.getByTestId('custom-body').closest('dl')).toBeNull();
  });

  it('renders a keyboard hint as a kbd element', () => {
    renderToolkit(<Kbd>C</Kbd>);
    expect(screen.getByText('C').tagName).toBe('KBD');
  });

  it('shows an actionable empty state and a working error retry', () => {
    const retry = vi.fn();
    renderToolkit(
      <>
        <EmptyState
          title="No accounts"
          description="Create the first account"
          action={
            <button data-testid="empty-create" onClick={retry}>
              Create account
            </button>
          }
        />
        <ErrorState message="Could not load accounts" onRetry={retry} />
      </>
    );
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('Create the first account');
    fireEvent.click(screen.getByTestId('empty-create'));
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe('formatUtc and RelativeTime', () => {
  it('formats an exact UTC time', () => {
    expect(formatUtc(new Date('2026-03-14T09:12:00Z'))).toBe('14 Mar 2026, 09:12 UTC');
  });

  it('shows a prefixed relative time with a machine-readable datetime, and nothing for an invalid date', () => {
    const at = new Date(Date.now() - 2 * 86_400_000);
    renderToolkit(
      <>
        <RelativeTime prefix="Active" at={at} data-testid="rel-valid" />
        <RelativeTime at="not-a-date" data-testid="rel-invalid" />
      </>
    );
    expect(screen.getByTestId('rel-valid')).toHaveTextContent(/^Active 2 days ago$/);
    expect(screen.getByTestId('rel-valid')).toHaveAttribute('datetime', at.toISOString());
    expect(screen.queryByTestId('rel-invalid')).not.toBeInTheDocument();
  });
});

describe('EntityHeader', () => {
  it('copies IDs and emails and exposes exact UTC on hover', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderToolkit(
      <EntityHeader
        title="Example account"
        id="account-123"
        email="example@example.com"
        timestamp={new Date(Date.now() - 3_600_000).toISOString()}
      />
    );
    fireEvent.click(screen.getByTestId('admin-entity-copy-id-btn'));
    fireEvent.click(screen.getByTestId('admin-entity-copy-email-btn'));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, 'example@example.com'));
    expect(writeText).toHaveBeenNthCalledWith(1, 'account-123');
    expect(screen.getByTestId('admin-entity-time')).toHaveTextContent('1 hour ago');
    fireEvent.mouseOver(screen.getByTestId('admin-entity-time'));
    const isoDatetime = screen.getByTestId('admin-entity-time').getAttribute('datetime') ?? '';
    expect(await screen.findByRole('tooltip')).toHaveTextContent(formatUtc(new Date(isoDatetime)));
  });

  it('reports clipboard failures and omits invalid dates', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
      configurable: true,
    });
    renderToolkit(<EntityHeader title="Account" id="123" timestamp="not-a-date" />);
    fireEvent.click(screen.getByTestId('admin-entity-copy-id-btn'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not copy. Try again.'));
    expect(screen.queryByTestId('admin-entity-time')).not.toBeInTheDocument();
  });
});

function SelectionExample() {
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: ['one', 'two'] });
  return (
    <BulkActionBar
      selection={selection}
      totalMatching={250}
      onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
      onClear={() => setSelection({ mode: 'explicit', ids: [] })}
    >
      <button data-testid="bulk-revoke">Revoke keys</button>
    </BulkActionBar>
  );
}
it('renders several time lines, an avatar and status chips in an entity header', () => {
  renderToolkit(
    <EntityHeader
      title="Ada"
      id="u1"
      avatar={<span data-testid="avatar" />}
      status={<span data-testid="status" />}
      times={[
        { prefix: 'Joined', at: new Date(Date.now() - 86_400_000), 'data-testid': 'time-joined' },
        { prefix: 'Active', at: new Date(Date.now() - 3_600_000), 'data-testid': 'time-active' },
      ]}
    />
  );
  expect(screen.getByTestId('avatar')).toBeInTheDocument();
  expect(screen.getByTestId('status')).toBeInTheDocument();
  expect(screen.getByTestId('time-joined')).toHaveTextContent('Joined yesterday');
  expect(screen.getByTestId('time-active')).toHaveTextContent('Active 1 hour ago');
});

it('offers all matching selection, keeps actions and clears the floating bar', () => {
  renderToolkit(<SelectionExample />);
  expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('2 selected');
  fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
  expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('250 selected');
  expect(within(screen.getByTestId('admin-bulk-action-bar')).getByTestId('bulk-revoke')).toBeVisible();
  expect(screen.queryByTestId('admin-select-all-matching-btn')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('admin-clear-selection-btn'));
  expect(screen.queryByTestId('admin-bulk-action-bar')).not.toBeInTheDocument();
});
