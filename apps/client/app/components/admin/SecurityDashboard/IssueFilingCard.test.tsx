import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecopsTriageStatusResponse } from '@client/pages/api/admin/secops-triage/status';

const mocks = vi.hoisted(() => ({
  status: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@client/app/hooks/data/admin', () => ({ useSecopsTriageStatus: () => mocks.status }));
vi.mock('./IssueFilingSettingsDialog', () => ({
  IssueFilingSettingsDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="settings-dialog-stub">
      <button type="button" onClick={onClose} data-testid="settings-dialog-stub-close">
        close
      </button>
    </div>
  ),
}));

import { filingScope, IssueFilingCard } from './IssueFilingCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IssueFilingCard />
    </CssVarsProvider>
  );

const ready = (overrides: Partial<SecopsTriageStatusResponse> = {}): SecopsTriageStatusResponse => ({
  stage: 'test-stage',
  enabled: true,
  dryRun: false,
  severityThreshold: 'high',
  maxIssuesPerScan: 20,
  github: { connected: true, repo: 'acme/tracker', check: { ok: true } },
  recentRuns: [],
  latestRunPerSource: [],
  ...overrides,
});

const chip = (suffix: string) => screen.getByTestId(`security-issue-filing-${suffix}-chip`);

describe('IssueFilingCard', () => {
  beforeEach(() => {
    Object.assign(mocks.status, { data: ready(), isLoading: false, isError: false, isFetching: false });
    mocks.status.refetch.mockReset();
  });

  it('shows a connected, ready repository with its name, and filing on', () => {
    renderCard();

    expect(within(screen.getByTestId('security-issue-filing')).getByText('Issue filing')).toBeInTheDocument();
    expect(chip('connection')).toHaveTextContent('Connected');
    expect(chip('connection')).toHaveAttribute('data-tone', 'good');
    expect(chip('repo')).toHaveTextContent('Ready');
    expect(screen.getByTestId('security-issue-filing-repo')).toHaveTextContent('acme/tracker');
    expect(chip('filing')).toHaveTextContent('On');
    expect(chip('filing')).toHaveAttribute('data-tone', 'good');
    expect(screen.queryByTestId('security-issue-filing-dry-run-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('security-issue-filing-filing')).toHaveTextContent(
      'High and above, up to 20 issues per scan'
    );
  });

  it('shows filing off, the dry run and a critical-only threshold', () => {
    mocks.status.data = ready({ enabled: false, dryRun: true, severityThreshold: 'critical', maxIssuesPerScan: 1 });
    renderCard();

    expect(chip('filing')).toHaveTextContent('Off');
    expect(chip('filing')).toHaveAttribute('data-tone', 'neutral');
    expect(chip('dry-run')).toHaveTextContent('Dry run');
    expect(chip('dry-run')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('security-issue-filing-filing')).toHaveTextContent(
      'Critical only, up to 1 issue per scan'
    );
  });

  it('shows no connection, and a repository that could not be checked', () => {
    mocks.status.data = ready({ github: { connected: false, repo: 'acme/tracker', check: null } });
    renderCard();

    expect(chip('connection')).toHaveTextContent('Not connected');
    expect(chip('connection')).toHaveAttribute('data-tone', 'bad');
    expect(chip('repo')).toHaveTextContent('Could not be checked');
  });

  it('says the repository is not set when there is none and no check ran', () => {
    mocks.status.data = ready({ github: { connected: false, repo: '', check: null } });
    renderCard();

    expect(chip('repo')).toHaveTextContent('Not set');
    expect(chip('repo')).toHaveAttribute('data-tone', 'neutral');
  });

  it('says the repository could not be checked when the lookup failed', () => {
    mocks.status.data = ready({ github: { connected: true, repo: 'acme/tracker', check: null, checkError: true } });
    renderCard();

    expect(chip('repo')).toHaveTextContent('Could not be checked');
  });

  it.each([
    ['not_configured', 'Not set', 'neutral'],
    ['not_allowed', "Not in the connection's allowed repositories", 'bad'],
    ['not_found', 'Not found', 'bad'],
    ['public', 'Public (must be private)', 'bad'],
    ['archived', 'Archived (read-only)', 'bad'],
    ['issues_disabled', 'Issues disabled', 'bad'],
  ] as const)('labels a %s repository', (reason, label, tone) => {
    mocks.status.data = ready({ github: { connected: true, repo: 'acme/tracker', check: { ok: false, reason } } });
    renderCard();

    expect(chip('repo')).toHaveTextContent(label);
    expect(chip('repo')).toHaveAttribute('data-tone', tone);
  });

  it('opens the settings dialog from Edit settings and closes it again', () => {
    renderCard();
    expect(screen.queryByTestId('settings-dialog-stub')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('security-issue-filing-settings-btn'));
    expect(screen.getByTestId('settings-dialog-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-dialog-stub-close'));
    expect(screen.queryByTestId('settings-dialog-stub')).not.toBeInTheDocument();
  });

  it('shows a loading state while the status loads, with the settings still reachable', () => {
    Object.assign(mocks.status, { data: undefined, isLoading: true });
    renderCard();

    expect(screen.getByTestId('security-issue-filing-loading')).toHaveTextContent('Loading issue filing status');
    fireEvent.click(screen.getByTestId('security-issue-filing-settings-btn'));
    expect(screen.getByTestId('settings-dialog-stub')).toBeInTheDocument();
  });

  it('shows an error with a retry when the status fails to load', () => {
    Object.assign(mocks.status, { data: undefined, isError: true });
    renderCard();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Issue filing status could not be loaded.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.status.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('filingScope', () => {
  it('names the threshold and the per-scan cap', () => {
    expect(filingScope({ severityThreshold: 'high', maxIssuesPerScan: 5 })).toBe(
      'High and above, up to 5 issues per scan'
    );
    expect(filingScope({ severityThreshold: 'critical', maxIssuesPerScan: 1 })).toBe(
      'Critical only, up to 1 issue per scan'
    );
  });
});
