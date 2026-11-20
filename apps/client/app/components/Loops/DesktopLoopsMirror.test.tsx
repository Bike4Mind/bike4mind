import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IDesktopLoopMirror } from '@client/app/hooks/data/loops';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ loops: undefined as IDesktopLoopMirror[] | undefined }));
vi.mock('@client/app/hooks/data/loops', () => ({
  useDesktopLoopMirror: () => ({ data: h.loops, dataUpdatedAt: Date.now() }),
}));

import DesktopLoopsMirror from './DesktopLoopsMirror';

const appTheme = extendTheme({ ...getThemeConfig() });
const mirror = (patch: Partial<IDesktopLoopMirror['snapshot']>, lastSeenAt: string): IDesktopLoopMirror => ({
  localLoopId: 'l1',
  lastSeenAt,
  snapshot: {
    name: 'Docs',
    status: 'live',
    stages: ['todo'],
    lanesBusy: 0,
    lanes: 2,
    spentToday: 4,
    budget: 50,
    needsYou: 0,
    tickets: [{ title: 'Fix the guide', stage: 'todo', status: 'blocked', reason: 'CI is red' }],
    ...patch,
  },
});
const renderIt = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DesktopLoopsMirror />
    </CssVarsProvider>
  );

describe('DesktopLoopsMirror', () => {
  it('renders nothing with no Desktop loops', () => {
    h.loops = [];
    const { container } = renderIt();
    expect(container.textContent).toBe('');
  });

  it('always says why an idle loop is idle, and how fresh the snapshot is', () => {
    h.loops = [mirror({ idleReason: 'capped until 01:00 (daily budget)' }, new Date().toISOString())];
    renderIt();
    expect(screen.getByTestId('loops-desktop-idle-reason')).toHaveTextContent('capped until 01:00 (daily budget)');
    expect(screen.getByTestId('loops-desktop-last-seen')).toHaveTextContent(
      '0/2 lanes - 4/50 credits today - last seen just now'
    );
    expect(screen.getByTestId('loops-desktop-last-seen')).not.toHaveTextContent('offline');
  });

  it('shows an old snapshot as stale, not dead, and lists the tickets read-only', () => {
    h.loops = [mirror({}, new Date(Date.now() - 2 * 60 * 60_000).toISOString())];
    renderIt();
    expect(screen.getByTestId('loops-desktop-last-seen')).toHaveTextContent(
      'last seen 2 h ago - Desktop offline or asleep'
    );
    expect(screen.getByTestId('loops-desktop-idle-reason')).toHaveTextContent('idle');
    fireEvent.click(screen.getByTestId('loops-desktop-row-l1'));
    expect(screen.getByTestId('loops-desktop-tickets-l1')).toHaveTextContent('Fix the guide - blocked: CI is red');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
