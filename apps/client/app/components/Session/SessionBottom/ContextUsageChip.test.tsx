import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';
import ContextUsageChip from './ContextUsageChip';

const appTheme = extendTheme({ ...getThemeConfig() });

const usage = (pct: number, extra: Partial<SessionContextUsage> = {}): SessionContextUsage => ({
  actualInputTokens: pct * 1600,
  contextLimit: 200_000,
  safeMaxInputTokens: 160_000,
  utilizationPercentage: pct,
  band: pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'normal',
  isApproachingLimit: pct >= 75,
  overflowDetected: false,
  cachingIneffective: false,
  compactedTurns: 0,
  ...extra,
});

const renderChip = (props: React.ComponentProps<typeof ContextUsageChip>) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ContextUsageChip {...props} />
    </CssVarsProvider>
  );

describe('ContextUsageChip', () => {
  it('renders nothing before the first turn while the message fits', () => {
    renderChip({ usage: null, modelName: 'GPT-5.4 Mini' });
    expect(screen.queryByTestId('context-usage-chip')).toBeNull();
  });

  it('shows the percentage, quiet below the warning band', () => {
    renderChip({ usage: usage(23), modelName: 'GPT-5.4 Mini' });
    const chip = screen.getByTestId('context-usage-chip');
    expect(chip).toHaveTextContent('23%');
    expect(chip).toHaveAttribute('data-band', 'normal');
  });

  it('turns warning, then danger, as the context fills', () => {
    const { unmount } = renderChip({ usage: usage(78), modelName: 'GPT-5.4 Mini' });
    expect(screen.getByTestId('context-usage-chip')).toHaveAttribute('data-band', 'warning');
    unmount();
    renderChip({ usage: usage(94), modelName: 'GPT-5.4 Mini' });
    expect(screen.getByTestId('context-usage-chip')).toHaveAttribute('data-band', 'danger');
  });

  it('treats an overflow as danger and explains it, with compaction and caching, in the tooltip', async () => {
    renderChip({
      usage: usage(70, { overflowDetected: true, compactedTurns: 3, cachingIneffective: true }),
      modelName: 'GPT-5.4 Mini',
    });
    const chip = screen.getByTestId('context-usage-chip');
    expect(chip).toHaveAttribute('data-band', 'danger');
    fireEvent.mouseOver(chip);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Context is full for GPT-5.4 Mini');
    expect(tooltip).toHaveTextContent('Condensed 3 earlier turns');
    expect(tooltip).toHaveTextContent('no caching discount');
  });

  it('flags a message that alone is over the limit before any turn', () => {
    renderChip({ usage: null, modelName: 'GPT-5.4 Mini', inputOverLimit: true });
    const chip = screen.getByTestId('context-usage-chip');
    expect(chip).toHaveTextContent('Too long');
    expect(chip).toHaveAttribute('data-band', 'danger');
  });

  it('turns red and names a file on this turn that will be cut to fit, announced without hovering', () => {
    renderChip({
      usage: usage(31),
      modelName: 'GPT-5.4 Mini',
      attachment: { fileName: 'q3-report.pdf', deliveredPercent: 42, measured: 'extracted', siblingCount: 0 },
    });
    const chip = screen.getByTestId('context-usage-chip');
    expect(chip).toHaveAttribute('data-band', 'danger');
    expect(screen.getByRole('status')).toHaveTextContent('"q3-report.pdf" is too large for GPT-5.4 Mini - about 42%');
  });
});
