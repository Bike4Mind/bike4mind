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
    // The owner made it due (or rescheduled) since the defer: the hold no longer explains the wait.
    expect(holdLabel({ ...paced, nextRunAt: new Date(now) }, now)).toBeNull();
  });

  it('explains a p2 budget hold until midnight, and drops it once a p0/p1 makes the loop due', () => {
    const until = new Date('2026-10-30T00:00:00Z');
    const held = { ...live, nextRunAt: until, hold: { kind: 'priority_budget' as const, until, at: new Date(now) } };
    expect(holdLabel(held, now)).toBe('p2 budget used for today; next p2 at 00:00 UTC');
    expect(holdLabel({ ...held, nextRunAt: new Date(now) }, now)).toBeNull();
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
    expect(holdLabel({ ...live, status: 'paused', activeExecutionIds: ['exec-1'], hold }, now)).toBeNull();
  });

  it('names the limit a capacity hold waits on, and shows it while lanes run', () => {
    const at = new Date(now);
    const label = (limit: 'loop' | 'user' | 'server' | 'budget') =>
      holdLabel({ ...live, maxConcurrent: 3, activeExecutionIds: ['a'], hold: { kind: 'capacity', limit, at } }, now);
    expect(label('loop')).toBe('All 3 run lanes busy (loop lane limit)');
    expect(label('user')).toBe('Waiting for a free run slot (your cloud run limit)');
    expect(label('server')).toBe('Waiting for a free run slot (server-wide limit)');
    expect(label('budget')).toBe("Waiting for budget: running lanes have reserved the rest of today's budget");
    const backingOff = { ...live, idleStreak: 1, nextRunAt: new Date(now + 30 * 60_000) };
    expect(holdLabel({ ...backingOff, activeExecutionIds: ['a'] }, now)).toBeNull();
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
