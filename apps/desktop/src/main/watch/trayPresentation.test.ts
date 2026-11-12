import { describe, expect, it } from 'vitest';
import { EMPTY_WATCH_SNAPSHOT, type WatchOrchestration, type WatchSnapshot } from '@shared/watch';
import { TRAY_LABEL_MAX, needsYouTitle, trayPresentation, truncateLabel } from './trayPresentation';

function orchestration(overrides: Partial<WatchOrchestration> = {}): WatchOrchestration {
  return {
    rootId: 'root',
    title: 'Ship the release',
    agents: [
      { id: 'a', title: 'Tests', state: 'needs-you', activity: null },
      { id: 'b', title: 'Docs', state: 'working', activity: 'read_file README.md' },
    ],
    sessions: [],
    statuses: {},
    activity: {},
    lastActiveAt: 0,
    needsYouSince: 1,
    celebrate: false,
    ...overrides,
  };
}

const busy: WatchSnapshot = {
  overall: 'needs-you',
  needsYouCount: 1,
  orchestrations: [orchestration()],
  pending: [
    {
      approvalId: 'approval-1',
      sessionId: 'a',
      rootId: 'root',
      agentTitle: 'Tests',
      orchestrationTitle: 'Ship the release',
      summary: 'bash pnpm test',
      quick: true,
      since: 1,
    },
  ],
};

describe('needsYouTitle', () => {
  it('says nothing unless someone needs you', () => {
    expect(needsYouTitle(0)).toBe('');
    expect(needsYouTitle(1)).toBe('1 needs you');
    expect(needsYouTitle(3)).toBe('3 need you');
  });
});

describe('trayPresentation', () => {
  it('maps each overall state to its icon, with words only for needs-you', () => {
    for (const overall of ['idle', 'working', 'done'] as const) {
      const presentation = trayPresentation({ ...busy, overall, needsYouCount: 0, pending: [] }, false);
      expect(presentation.icon).toBe(overall);
      expect(presentation.title).toBe('');
    }
    const needsYou = trayPresentation(busy, false);
    expect(needsYou.icon).toBe('needs-you');
    expect(needsYou.title).toBe('1 needs you');
    expect(needsYou.tooltip).toBe('Bike4Mind - 1 needs you');
  });

  it('lists approvals first, then each orchestration with its agents', () => {
    const { items } = trayPresentation(busy, false);
    expect(items.map(item => item.kind)).toEqual([
      'header',
      'separator',
      'approval',
      'separator',
      'orchestration',
      'separator',
      'action',
      'action',
      'action',
    ]);
    expect(items[0]).toEqual({ kind: 'header', label: '2 agents: 1 needs you, 1 working' });
    expect(items[2]).toMatchObject({
      kind: 'approval',
      approvalId: 'approval-1',
      label: 'Tests: bash pnpm test',
      quick: true,
    });
    expect(items[4]).toMatchObject({
      kind: 'orchestration',
      label: 'Ship the release',
      agents: [
        { sessionId: 'a', label: '\u25CF Tests' },
        { sessionId: 'b', label: '\u25D0 Docs - read_file README.md' },
      ],
    });
  });

  it('flips the mini window action with its visibility', () => {
    const label = (miniOpen: boolean) =>
      trayPresentation(busy, miniOpen).items.find(item => item.kind === 'action' && item.action === 'toggle-mini');
    expect(label(false)).toMatchObject({ label: 'Show mini Tavern' });
    expect(label(true)).toMatchObject({ label: 'Hide mini Tavern' });
  });

  it('shows only the summary and the actions when nothing runs', () => {
    const { items, icon } = trayPresentation(EMPTY_WATCH_SNAPSHOT, false);
    expect(icon).toBe('idle');
    expect(items.map(item => (item.kind === 'action' ? item.action : item.kind))).toEqual([
      'header',
      'separator',
      'open-tavern',
      'toggle-mini',
      'hide-tray',
    ]);
  });
});

describe('truncateLabel', () => {
  it('keeps menu lines on one short line', () => {
    expect(truncateLabel('a\n  b')).toBe('a b');
    const long = truncateLabel('x'.repeat(200));
    expect(long).toHaveLength(TRAY_LABEL_MAX);
    expect(long.endsWith('\u2026')).toBe(true);
  });
});
