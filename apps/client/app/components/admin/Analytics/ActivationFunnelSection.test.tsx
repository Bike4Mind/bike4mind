import type { ReactNode } from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ActivationFunnel } from '@client/app/utils/activationFunnel';
import { ActivationFunnelSection } from './ActivationFunnelSection';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const ok = (patch: Partial<Extract<ActivationFunnel, { status: 'ok' }>> = {}): ActivationFunnel => ({
  status: 'ok',
  signups: 'legit',
  window: { createdFrom: '2026-05-19T00:00:00.000Z', createdTo: '2026-06-16T00:00:00.000Z' },
  steps: [
    { step: 'signedUp', reached: 40, stoppedHere: 10 },
    { step: 'firstAction', reached: 30, stoppedHere: 12 },
    { step: 'cameBack', reached: 18, stoppedHere: 14 },
    { step: 'paid', reached: 4, stoppedHere: 4 },
  ],
  tooNew: 5,
  paidPending: false,
  activationRate: { value: 45, previous: null },
  ...patch,
});

const ZERO_STEPS = (['signedUp', 'firstAction', 'cameBack', 'paid'] as const).map(step => ({
  step,
  reached: 0,
  stoppedHere: 0,
}));

const renderSection = (props: Partial<Parameters<typeof ActivationFunnelSection>[0]> = {}) => {
  const onSelectStep = vi.fn();
  const onRetry = vi.fn();
  render(
    <ActivationFunnelSection
      data={ok()}
      loading={false}
      error={false}
      onRetry={onRetry}
      onShowDefaultRange={vi.fn()}
      onSelectStep={onSelectStep}
      {...props}
    />,
    { wrapper: Wrapper }
  );
  return { onSelectStep, onRetry };
};

describe('ActivationFunnelSection', () => {
  it('shows a row per step with its count, percent of the previous step and stopped-here button', () => {
    renderSection();
    expect(screen.getByTestId('analytics-funnel-caption')).toHaveTextContent(
      '40 signups at least 7 days old; 5 too new to judge.'
    );
    const chart = screen.getByTestId('analytics-funnel-chart');
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Came back: 18 (60% of previous)'));
    expect(chart).toHaveTextContent('30 \u00b7 75% of previous');
    expect(screen.getByTestId('analytics-funnel-step-signedUp-btn')).toHaveTextContent('10 stopped here');
    expect(screen.getByTestId('analytics-funnel-step-signedUp-btn')).toHaveAccessibleName(
      '10 stopped here: list the signups who stopped at Signed up'
    );
    expect(screen.getByTestId('analytics-funnel-step-paid-btn')).toHaveTextContent('4 stopped here');
    expect(screen.queryByTestId('analytics-funnel-paid-pending-chip')).not.toBeInTheDocument();
  });

  it('marks the paid step pending while some signups are under 30 days old', () => {
    renderSection({ data: ok({ paidPending: true }) });
    expect(screen.getByTestId('analytics-funnel-paid-pending-chip')).toHaveTextContent('Pending');
  });

  it('selects the step whose button is clicked', () => {
    const { onSelectStep } = renderSection();
    fireEvent.click(screen.getByTestId('analytics-funnel-step-firstAction-btn'));
    expect(onSelectStep).toHaveBeenCalledWith('firstAction');
  });

  it('lists the steps as a table', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('analytics-funnel-table-toggle-btn'));
    const table = screen.getByTestId('analytics-funnel-table');
    expect(within(table).getByText('Stopped here')).toBeInTheDocument();
    expect(within(table).getByText('First AI action')).toBeInTheDocument();
  });

  it('shows a skeleton, an error with retry, and the empty state', () => {
    const { rerender } = render(
      <ActivationFunnelSection data={undefined} loading error={false} onRetry={vi.fn()} onSelectStep={vi.fn()} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId('analytics-funnel-skeleton')).toBeInTheDocument();
    const onRetry = vi.fn();
    rerender(
      <ActivationFunnelSection data={undefined} loading={false} error onRetry={onRetry} onSelectStep={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(onRetry).toHaveBeenCalled();
    rerender(
      <ActivationFunnelSection
        data={ok({ steps: ZERO_STEPS, tooNew: 0 })}
        loading={false}
        error={false}
        onRetry={vi.fn()}
        onSelectStep={vi.fn()}
      />
    );
    expect(screen.getByText('No activity in this range')).toBeInTheDocument();
  });

  it('says signups are too new to judge, with the count, when none are judged', () => {
    renderSection({ data: ok({ steps: ZERO_STEPS, tooNew: 50 }) });
    expect(screen.getByText('50 signups are too new to judge')).toBeInTheDocument();
    expect(screen.queryByText('No activity in this range')).not.toBeInTheDocument();
  });

  it('disables the step buttons and says so while the counts are updating', () => {
    const { onSelectStep } = renderSection({ updating: true });
    expect(screen.getByTestId('analytics-funnel-updating')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('analytics-funnel-step-paid-btn'));
    expect(onSelectStep).not.toHaveBeenCalled();
  });

  it('offers the last 90 days from the too-new state', () => {
    const onShowDefaultRange = vi.fn();
    renderSection({ data: ok({ steps: ZERO_STEPS, tooNew: 50 }), onShowDefaultRange });
    fireEvent.click(screen.getByTestId('analytics-funnel-show-90d-btn'));
    expect(onShowDefaultRange).toHaveBeenCalled();
  });

  it('hides the updating line when nothing is in flight but still disables the buttons', () => {
    renderSection({ updating: true, fetching: false });
    expect(screen.queryByTestId('analytics-funnel-updating')).not.toBeInTheDocument();
    expect(screen.getByTestId('analytics-funnel-step-paid-btn')).toBeDisabled();
  });

  it('uses the singular for one signup in the caption and the button name', () => {
    renderSection({
      data: ok({
        steps: [
          { step: 'signedUp', reached: 1, stoppedHere: 1 },
          { step: 'firstAction', reached: 0, stoppedHere: 0 },
          { step: 'cameBack', reached: 0, stoppedHere: 0 },
          { step: 'paid', reached: 0, stoppedHere: 0 },
        ],
      }),
    });
    expect(screen.getByTestId('analytics-funnel-caption')).toHaveTextContent('1 signup at least 7 days old');
    expect(screen.getByTestId('analytics-funnel-step-signedUp-btn')).toHaveAccessibleName(
      '1 stopped here: list the signup who stopped at Signed up'
    );
  });

  it('explains a range over the limit and offers the last 90 days', () => {
    const onShowDefaultRange = vi.fn();
    renderSection({ data: { status: 'rangeTooLong', maxDays: 93 }, onShowDefaultRange });
    expect(screen.getByText('The funnel covers up to 93 days of signups')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('analytics-funnel-show-90d-btn'));
    expect(onShowDefaultRange).toHaveBeenCalled();
  });

  it('shows a refused range with the server reason and no retry', () => {
    const message = 'More than 20,000 signups in this window. Narrow the created range.';
    renderSection({ data: undefined, refused: message });
    expect(screen.getByText('Too many signups to chart')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-retry-btn')).not.toBeInTheDocument();
  });

  it('shows a skeleton, not the previous empty state, while a new range loads', () => {
    renderSection({ data: { status: 'rangeTooLong', maxDays: 93 }, updating: true, fetching: true });
    expect(screen.queryByText('The funnel covers up to 93 days of signups')).not.toBeInTheDocument();
    expect(screen.getByTestId('analytics-funnel-skeleton')).toBeInTheDocument();
  });
});
