import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { holdLabel, loopNeedsOwner, LoopStatusChip } from './loopUi';

const appTheme = extendTheme({ ...getThemeConfig() });
const now = new Date('2026-10-29T12:00:00Z').getTime();
const live = { status: 'live' as const, nextRunAt: new Date(now - 60_000) };

describe('holdLabel', () => {
  it('explains a pacing hold until its deferred run is due', () => {
    const until = new Date(now + 90 * 60_000);
    const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const paced = { ...live, nextRunAt: until, hold: { kind: 'pacing' as const, until, at: new Date(now) } };
    expect(holdLabel(paced, now)).toBe(`Paced: next run at ${time} to spread the daily budget`);
    expect(holdLabel(paced, until.getTime() + 1)).toBeNull();
  });

  it('explains a capacity hold, then falls back to the back-off', () => {
    const capacity = { ...live, hold: { kind: 'capacity' as const, at: new Date(now) } };
    expect(holdLabel(capacity, now)).toBe('Waiting for a free run slot (server-wide limit)');
    const backingOff = { ...live, idleStreak: 1, nextRunAt: new Date(now + 30 * 60_000) };
    expect(holdLabel(backingOff, now)).toBe('Backing off: next run in 30 min, nothing changed in the last run');
    expect(holdLabel(live, now)).toBeNull();
  });

  it('is null for a loop that is not live or has a run in flight', () => {
    const hold = { kind: 'capacity' as const, at: new Date(now) };
    expect(holdLabel({ ...live, status: 'paused', hold }, now)).toBeNull();
    expect(holdLabel({ ...live, activeExecutionId: 'exec-1', hold }, now)).toBeNull();
  });
});

describe('liveness alarms', () => {
  const alarm = { kind: 'idle_with_work' as const, reason: 'Ready tickets waiting', since: new Date(now) };

  it('make a live loop need its owner', () => {
    expect(loopNeedsOwner({ status: 'live', blockedTickets: 0 })).toBe(false);
    expect(loopNeedsOwner({ status: 'live', blockedTickets: 0, alarm })).toBe(true);
  });

  it('show their reason under the status chip', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopStatusChip loop={{ status: 'live', alarm }} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('loop-alarm-reason').textContent).toBe('Ready tickets waiting');
  });
});
