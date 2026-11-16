import type { ReactNode } from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  AcquisitionConversion,
  AcquisitionMetrics,
  AcquisitionRow,
} from '@client/app/utils/acquisitionConversion';
import { AcquisitionSection } from './AcquisitionSection';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const metrics = (patch: Partial<AcquisitionMetrics> = {}): AcquisitionMetrics => ({
  signups: 10,
  matureSignups: 10,
  converted: 2,
  subscriptionFirst: 1,
  creditFirst: 1,
  both: 0,
  provisionalConverted: 0,
  provisional: false,
  conversionPct: 20,
  orgBuyers: 0,
  retained: 2,
  followUpBuyers: 2,
  followUpPending: 0,
  repeatCredit: 1,
  renewalDue: 1,
  renewed: 1,
  renewalUnavailable: 0,
  ...patch,
});

const touchRow = (key: string, patch: Partial<AcquisitionRow> = {}): AcquisitionRow => {
  const [source, medium, campaign] = key.split('|');
  return { kind: 'touch', key, source, medium, campaign, ...metrics(), ...patch };
};

const ok = (rows: AcquisitionRow[], patch: Partial<Extract<AcquisitionConversion, { status: 'ok' }>> = {}) =>
  ({
    status: 'ok',
    signups: 'legit',
    touch: 'first',
    window: { createdFrom: '2026-05-01T00:00:00.000Z', createdTo: '2026-06-01T00:00:00.000Z' },
    coverage: { signups: 20, attributed: 10, pct: 50 },
    conversionWindowDays: 30,
    followUpDays: 90,
    renewalBasis: 'subscription-state',
    totals: metrics({ signups: 20 }),
    rows,
    truncated: false,
    ...patch,
  }) satisfies AcquisitionConversion;

const renderSection = (props: Partial<Parameters<typeof AcquisitionSection>[0]> = {}) => {
  const onControlsChange = vi.fn();
  const onRetry = vi.fn();
  render(
    <AcquisitionSection
      data={ok([touchRow('google|cpc|spring')])}
      loading={false}
      error={false}
      controls={{ touch: 'first', window: '30', followUp: '90' }}
      onControlsChange={onControlsChange}
      onRetry={onRetry}
      {...props}
    />,
    { wrapper: Wrapper }
  );
  return { onControlsChange, onRetry };
};

describe('AcquisitionSection', () => {
  it('lists rows with coverage, the provisional chip and the unattributed label', () => {
    renderSection({
      data: ok([
        touchRow('google|cpc|spring', { provisional: true, provisionalConverted: 1, matureSignups: 8 }),
        touchRow('newsletter|(none)|(none)', { conversionPct: null, matureSignups: 0, converted: 0 }),
        { ...touchRow('unattributed'), kind: 'unattributed', source: null, medium: null, campaign: null },
      ]),
    });
    expect(screen.getByText(/10 of 20 signups attributed \(50\.0%\)/)).toBeInTheDocument();
    const google = screen.getByTestId('acquisition-row-google|cpc|spring');
    expect(within(google).getByTestId('acquisition-row-google|cpc|spring-provisional-chip')).toBeInTheDocument();
    expect(within(google).getByText('cpc / spring')).toBeInTheDocument();
    expect(within(google).getByText('2 (+1 pending)')).toBeInTheDocument();
    const newsletter = screen.getByTestId('acquisition-row-newsletter|(none)|(none)');
    expect(within(newsletter).queryByText('(none)')).not.toBeInTheDocument();
    expect(within(newsletter).getByText('-')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('acquisition-row-unattributed')).getByText('Unattributed / consent unknown')
    ).toBeInTheDocument();
    expect(screen.getByTestId('acquisition-section-unattributed-note')).toBeInTheDocument();
  });

  it('reports a control change', () => {
    const { onControlsChange } = renderSection();
    fireEvent.click(screen.getByTestId('acquisition-touch-toggle-last'));
    expect(onControlsChange).toHaveBeenCalledWith({ touch: 'last' });
    fireEvent.click(screen.getByTestId('acquisition-window-7'));
    expect(onControlsChange).toHaveBeenCalledWith({ window: '7' });
  });

  it('shows a loading skeleton', () => {
    renderSection({ data: undefined, loading: true });
    expect(screen.getByTestId('acquisition-section-skeleton')).toBeInTheDocument();
  });

  it('shows an error with retry', () => {
    const { onRetry } = renderSection({ data: undefined, error: true });
    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the empty state with no signups', () => {
    renderSection({ data: ok([], { coverage: { signups: 0, attributed: 0, pct: null } }) });
    expect(screen.getByText('No activity in this range')).toBeInTheDocument();
  });

  it('explains a range that is too long, keeping the controls', () => {
    const onShowDefaultRange = vi.fn();
    renderSection({ data: { status: 'rangeTooLong', maxDays: 93 }, onShowDefaultRange });
    expect(screen.getByText('Acquisition covers up to 93 days of signups')).toBeInTheDocument();
    expect(screen.getByTestId('acquisition-touch-toggle')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('acquisition-section-too-long-90d-btn'));
    expect(onShowDefaultRange).toHaveBeenCalled();
  });

  it('shows the server reason for a refused range', () => {
    renderSection({ data: undefined, refused: 'More than 20,000 signups in this range.' });
    expect(screen.getByText('More than 20,000 signups in this range.')).toBeInTheDocument();
  });

  it('shows a timeout notice', () => {
    renderSection({ data: undefined, timedOut: true });
    expect(screen.getByText('This range took too long to compute')).toBeInTheDocument();
  });
});
