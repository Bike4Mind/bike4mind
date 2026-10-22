import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ITurnTiming } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { TurnTimingNotice } from './TurnTimingNotice';

const copyTextWithToast = vi.fn();
vi.mock('@client/app/utils/copyToClipboard', () => ({
  copyTextWithToast: (...args: unknown[]) => copyTextWithToast(...args),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderNotice = (props: React.ComponentProps<typeof TurnTimingNotice>) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TurnTimingNotice {...props} />
    </CssVarsProvider>
  );

const retriedTurn: ITurnTiming = {
  queueMs: 100,
  semaphoreWaitMs: 0,
  totalMs: 415_000,
  retries: [{ reason: 'stream_idle_timeout', delayMs: 3500, model: 'model-a', at: new Date() }],
  fallbackHops: 0,
};

describe('TurnTimingNotice', () => {
  beforeEach(() => {
    copyTextWithToast.mockClear();
  });

  it('summarizes a retried turn and copies its turn ID', () => {
    renderNotice({ questId: 'quest-123', timing: retriedTurn });

    expect(screen.getByTestId('turn-timing-notice').textContent).toContain('1 retry (response stalled)');
    fireEvent.click(screen.getByTestId('turn-timing-copy-id-btn'));

    expect(copyTextWithToast).toHaveBeenCalledWith('quest-123', 'Turn ID copied');
  });

  it('renders nothing for an unremarkable turn', () => {
    renderNotice({ questId: 'quest-123', timing: { ...retriedTurn, retries: [], totalMs: 3000 } });

    expect(screen.queryByTestId('turn-timing-notice')).toBeNull();
  });
});
