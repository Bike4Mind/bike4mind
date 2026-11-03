import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModerationIncidentRow } from '@client/app/hooks/data/moderationIncidents';

const m = vi.hoisted(() => ({
  queue: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock('@client/app/hooks/data/moderationIncidents', () => ({ useModerationIncidentQueue: m.queue }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => m.search, useNavigate: () => m.navigate }));
vi.mock('./ModerationIncidentDetail', () => ({
  default: (props: { incidentId: string; onBack: () => void }) => (
    <button type="button" data-testid="detail-stub" onClick={props.onBack}>
      {props.incidentId}
    </button>
  ),
}));

import ModerationIncidentsTab from './ModerationIncidentsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ModerationIncidentsTab />
    </CssVarsProvider>
  );

const rows: ModerationIncidentRow[] = [
  { id: 'inc-old', createdAt: '2026-10-01T10:00:00.000Z', surface: 'upload', stuck: false },
  { id: 'inc-stuck', createdAt: '2026-10-02T10:00:00.000Z', surface: 'generation', stuck: true },
];
const ready = (data: ModerationIncidentRow[], truncated = false) => ({
  data: { rows: data, truncated },
  isPending: false,
  error: null,
  refetch: vi.fn(),
});

describe('ModerationIncidentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.search = {};
    m.queue.mockReturnValue(ready(rows));
  });

  it('lists id, time, surface and age in the order given, flagging a stuck report', () => {
    renderTab();
    const first = screen.getByTestId('moderation-incident-row-inc-old');
    const second = screen.getByTestId('moderation-incident-row-inc-stuck');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.textContent).toContain('inc-old');
    expect(first.textContent).toContain('Upload');
    expect(first.textContent).toMatch(/1 Oct 2026/);
    expect(first.textContent).toMatch(/ago/);
    expect(second.textContent).toContain('Report stuck');
    expect(screen.getByTestId('admin-page-header').textContent).toContain('(2)');
  });

  it('opens an incident through the incidentId search param', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('moderation-incident-row-inc-old'));
    expect(m.navigate).toHaveBeenCalledTimes(1);
    const { search } = m.navigate.mock.calls[0][0] as { search: (prev: object) => object };
    expect(search({ tab: 'moderation-incidents' })).toEqual({ tab: 'moderation-incidents', incidentId: 'inc-old' });
  });

  it('shows the detail for a linked incident and clears the param on back', () => {
    m.search = { incidentId: 'inc-linked' };
    renderTab();
    expect(screen.queryByTestId('moderation-incidents-table')).toBeNull();
    fireEvent.click(screen.getByTestId('detail-stub'));
    const { search } = m.navigate.mock.calls[0][0] as { search: (prev: object) => object };
    expect(search({ incidentId: 'inc-linked' })).toEqual({ incidentId: undefined });
  });

  it('warns when the queue came back at its cap', () => {
    m.queue.mockReturnValue(ready(rows, true));
    renderTab();
    expect(screen.getByTestId('moderation-incidents-truncated').textContent).toContain('Showing the oldest 2');
  });

  it('shows an empty state when nothing waits', () => {
    m.queue.mockReturnValue(ready([]));
    renderTab();
    expect(screen.getByTestId('admin-empty-state').textContent).toContain('No incidents are waiting for review');
  });
});
