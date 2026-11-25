// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionStatus } from '@shared/chat';
import { sessionFixture } from '../orchestrator/sessionFixture';
import { createThemedMount, el, query } from '../orchestrator/testUtils';
import { MissionControl } from './MissionControl';

const themed = createThemedMount();
const onOpen = vi.fn();
const onOpenBeside = vi.fn();
const onClose = vi.fn();

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

const SESSIONS = [
  sessionFixture('alpha', undefined, { title: 'Alpha run' }),
  sessionFixture('alpha-a', 'alpha'),
  sessionFixture('beta', undefined, { title: 'Beta run' }),
  sessionFixture('beta-a', 'beta'),
  sessionFixture('plain', undefined, { title: 'Plain chat' }),
];
const STATUSES = new Map<string, ChatSessionStatus>([['beta-a', 'needs-action']]);

const renderMissionControl = (sessions = SESSIONS, presenting = false) =>
  themed.render(
    <MissionControl
      sessions={sessions}
      statuses={STATUSES}
      presenting={presenting}
      onOpen={onOpen}
      onOpenBeside={onOpenBeside}
      onClose={onClose}
    />
  );

async function typeFilter(text: string) {
  const input = el('mission-control-filter-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const tileIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="mission-control-tile-"]')].map(tile =>
    tile.dataset.testid?.replace('mission-control-tile-', '')
  );

describe('MissionControl', () => {
  it('shows one tile per orchestration, needs-you first, with its badge and counts', async () => {
    await renderMissionControl();
    expect(tileIds()).toEqual(['beta', 'alpha']);
    expect(el('mission-control-tile-beta').querySelector('[data-testid="mission-control-needs-you"]')).not.toBeNull();
    expect(el('mission-control-tile-alpha').querySelector('[data-testid="mission-control-needs-you"]')).toBeNull();
    expect(el('mission-control-tile-beta').textContent).toContain('1 needs you');
  });

  it('opens a tile on click, and beside the active one on Shift+click or its button', async () => {
    await renderMissionControl();
    act(() => el('mission-control-tile-alpha').click());
    expect(onOpen).toHaveBeenCalledWith('alpha');

    act(() => {
      el('mission-control-tile-alpha').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    act(() => el('mission-control-open-beside-btn-beta').click());
    expect(onOpenBeside.mock.calls).toEqual([['alpha'], ['beta']]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('narrows the tiles by title as the filter is typed', async () => {
    await renderMissionControl();
    await typeFilter('alp');
    expect(tileIds()).toEqual(['alpha']);
    await typeFilter('nothing like it');
    expect(tileIds()).toEqual([]);
    expect(el('mission-control-empty').textContent).toContain('No orchestration matches');
  });

  it('hides titles while presenting', async () => {
    await renderMissionControl(SESSIONS, true);
    expect(el('mission-control-tile-beta').textContent).toContain('Session 1');
    expect(document.body.textContent).not.toContain('Beta run');
  });

  it('explains the empty state when no session runs agents', async () => {
    await renderMissionControl([sessionFixture('plain')]);
    expect(query('mission-control-grid')).toBeNull();
    expect(el('mission-control-empty').textContent).toBe('Orchestrations appear here once a session starts agents.');
  });
});
