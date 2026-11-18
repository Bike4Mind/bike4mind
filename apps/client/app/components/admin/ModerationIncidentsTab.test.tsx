import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModerationIncidentRow, ModerationIncidentSummary } from '@client/app/hooks/data/moderationIncidents';

const m = vi.hoisted(() => ({
  queue: vi.fn(),
  summary: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock('@client/app/hooks/data/moderationIncidents', () => ({
  useModerationIncidentQueue: m.queue,
  useModerationIncidentSummary: m.summary,
}));
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

const row = (over: Partial<ModerationIncidentRow>): ModerationIncidentRow => ({
  id: 'inc',
  createdAt: '2026-10-01T10:00:00.000Z',
  userId: 'user-1',
  userEmail: 'flagged@example.com',
  topLabel: { name: 'Explicit Nudity', parentName: 'Explicit', confidence: 97.5 },
  surface: 'upload',
  reviewStatus: 'pending_review',
  stuck: false,
  escalated: false,
  ...over,
});
const rows: ModerationIncidentRow[] = [
  row({ id: 'inc-old' }),
  row({
    id: 'inc-stuck',
    createdAt: '2026-10-02T10:00:00.000Z',
    surface: 'generation',
    reviewStatus: 'confirmed_csam',
    userEmail: null,
    topLabel: null,
    stuck: true,
  }),
];
const ready = (data: ModerationIncidentRow[], truncated = false) => ({
  data: { rows: data, truncated },
  isPending: false,
  error: null,
  refetch: vi.fn(),
});

// Synthetic counts only.
const totals = (over: Partial<ModerationIncidentSummary> = {}): ModerationIncidentSummary => ({
  needsReview: 2,
  escalated: 0,
  stuck: 0,
  closed: { noAction: 0, falsePositive: 0, reported: 0 },
  oldestPendingCreatedAt: '2026-10-01T10:00:00.000Z',
  reviewersConfigured: true,
  escalationReviewersConfigured: true,
  ...over,
});
const summaryReady = (data: ModerationIncidentSummary) => ({
  data,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
});
const stat = (name: string) => screen.getByTestId(`moderation-incidents-stat-${name}`).textContent;

describe('ModerationIncidentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.search = {};
    m.queue.mockReturnValue(ready(rows));
    m.summary.mockReturnValue(summaryReady(totals()));
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
    expect(m.queue).toHaveBeenCalledWith('open', undefined);
  });

  it('shows which review step holds each waiting incident, by role', () => {
    m.queue.mockReturnValue(ready([row({ id: 'inc-first' }), row({ id: 'inc-second', escalated: true })]));
    renderTab();
    const first = screen.getByTestId('moderation-incident-held-by-inc-first');
    const second = screen.getByTestId('moderation-incident-held-by-inc-second');
    expect(first.textContent).toBe('First reviewer');
    expect(first.getAttribute('data-tone')).toBe('neutral');
    expect(second.textContent).toBe('Second reviewer');
    expect(second.getAttribute('data-tone')).toBe('info');
    expect(screen.getByTestId('moderation-incidents-table').textContent).toContain('Held by');
  });

  it('leaves Held by off the closed list', () => {
    renderTab();
    m.queue.mockReturnValue(ready([row({ id: 'inc-closed-esc', reviewStatus: 'no_action', escalated: true })]));
    fireEvent.click(screen.getByTestId('moderation-incidents-status-closed'));
    expect(screen.queryByTestId('moderation-incident-held-by-inc-closed-esc')).toBeNull();
    expect(screen.getByTestId('moderation-incidents-table').textContent).not.toContain('Held by');
  });

  it('names the flagged user and the top label, falling back to the user id', () => {
    renderTab();
    const first = screen.getByTestId('moderation-incident-row-inc-old').textContent ?? '';
    expect(first).toContain('flagged@example.com');
    expect(first).toContain('Explicit Nudity (Explicit) 97.5%');
    expect(screen.getByTestId('moderation-incident-row-inc-stuck').textContent).toContain('user-1');
  });

  it('switches to closed incidents and shows each verdict', () => {
    renderTab();
    m.queue.mockReturnValue(ready([row({ id: 'inc-closed', reviewStatus: 'no_action' })]));
    fireEvent.click(screen.getByTestId('moderation-incidents-status-closed'));
    expect(m.queue).toHaveBeenLastCalledWith('closed', undefined);
    expect(screen.getByTestId('moderation-incident-row-inc-closed').textContent).toContain('No action');
    expect(screen.queryByTestId('moderation-incidents-paging')).toBeNull();
  });

  it('offers no Show older button when the closed list is not truncated', () => {
    m.queue.mockReturnValue(ready([row({ id: 'inc-a', reviewStatus: 'no_action' })], false));
    renderTab();
    fireEvent.click(screen.getByTestId('moderation-incidents-status-closed'));
    expect(screen.queryByTestId('moderation-incidents-older-btn')).toBeNull();
  });

  it('pages a full closed list back from its oldest row, and returns to the newest', () => {
    const page = [
      row({ id: 'inc-new', createdAt: '2026-10-05T10:00:00.000Z', reviewStatus: 'reported' }),
      row({ id: 'inc-oldest', createdAt: '2026-10-03T10:00:00.000Z', reviewStatus: 'no_action' }),
    ];
    m.queue.mockReturnValue(ready(page, true));
    renderTab();
    fireEvent.click(screen.getByTestId('moderation-incidents-status-closed'));
    expect(screen.queryByTestId('moderation-incidents-truncated')).toBeNull();

    fireEvent.click(screen.getByTestId('moderation-incidents-older-btn'));
    expect(m.queue).toHaveBeenLastCalledWith('closed', {
      before: '2026-10-03T10:00:00.000Z',
      beforeId: 'inc-oldest',
    });
    expect(screen.getByTestId('moderation-incidents-paging').textContent).toContain('from before');

    fireEvent.click(screen.getByTestId('moderation-incidents-newest-btn'));
    expect(m.queue).toHaveBeenLastCalledWith('closed', undefined);
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
    expect(screen.getByTestId('moderation-incidents-truncated').textContent).toContain(
      'Showing the oldest 2; more are waiting'
    );
    expect(screen.getByTestId('admin-page-header').textContent).not.toContain('(2)');
  });

  it('shows an empty state when nothing waits', () => {
    m.queue.mockReturnValue(ready([]));
    renderTab();
    expect(screen.getByTestId('admin-empty-state').textContent).toContain('No incidents are waiting for review');
  });
  describe('summary', () => {
    it('shows the totals between the header and the queue control', () => {
      m.summary.mockReturnValue(
        summaryReady(
          totals({
            needsReview: 1204,
            escalated: 3,
            closed: { noAction: 7, falsePositive: 1, reported: 2 },
          })
        )
      );
      renderTab();

      const region = screen.getByTestId('moderation-incidents-summary');
      const header = screen.getByTestId('admin-page-header');
      const control = screen.getByTestId('moderation-incidents-status');
      expect(header.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(region.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(region.textContent).toContain('Needs review');
      expect(stat('needs-review')).toBe('1,204');
      expect(stat('oldest-waiting')).toMatch(/ago/);
      expect(region.textContent).toMatch(/1 Oct 2026, 10:00 UTC/);
      expect(stat('escalated')).toBe('3');
      expect(stat('reported')).toBe('2');
      expect(stat('closed-without-report')).toBe('8');
      expect(stat('closed-without-report-split')).toBe('7 correctly blocked, 1 false positive');
      expect(screen.getAllByTestId('admin-stat-tile')).toHaveLength(5);
    });

    it('shows stuck reports only when there are some', () => {
      renderTab();
      expect(screen.queryByTestId('moderation-incidents-stat-stuck')).toBeNull();
    });

    it('notes stuck reports under Needs review', () => {
      m.summary.mockReturnValue(summaryReady(totals({ stuck: 2 })));
      renderTab();
      expect(stat('stuck')).toBe('Plus 2 reports stuck');
    });

    it('shows a dash when nothing is waiting', () => {
      m.summary.mockReturnValue(summaryReady(totals({ needsReview: 0, oldestPendingCreatedAt: null })));
      renderTab();
      expect(stat('needs-review')).toBe('0');
      expect(stat('oldest-waiting')).toBe('\u2014');
    });

    it('keeps the queue working when the totals fail to load, and retries them', () => {
      const failed = { data: undefined, isPending: false, isError: true, isFetching: false, refetch: vi.fn() };
      m.summary.mockReturnValue(failed);
      renderTab();

      const region = screen.getByTestId('moderation-incidents-summary');
      expect(region.textContent).toContain("Couldn't load the review totals.");
      expect(screen.getByTestId('moderation-incident-row-inc-old')).toBeTruthy();
      fireEvent.click(screen.getByTestId('moderation-incident-row-inc-old'));
      expect(m.navigate).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
      expect(failed.refetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the queue visible while the totals load', () => {
      m.summary.mockReturnValue({
        data: undefined,
        isPending: true,
        isError: false,
        isFetching: true,
        refetch: vi.fn(),
      });
      renderTab();
      expect(screen.getAllByTestId('admin-stat-skeleton')).toHaveLength(5);
      expect(screen.getByTestId('moderation-incident-row-inc-old')).toBeTruthy();
      expect(screen.queryByTestId('moderation-incidents-no-reviewers-banner')).toBeNull();
    });
  });

  describe('reviewer banners', () => {
    it('shows none when both reviewer lists are set', () => {
      m.summary.mockReturnValue(summaryReady(totals({ escalated: 1 })));
      renderTab();
      expect(screen.queryByTestId('moderation-incidents-no-reviewers-banner')).toBeNull();
      expect(screen.queryByTestId('moderation-incidents-no-escalation-reviewers-banner')).toBeNull();
    });

    it('says no reviewer is emailed while incidents wait and the reviewer list is empty', () => {
      m.summary.mockReturnValue(summaryReady(totals({ needsReview: 2, reviewersConfigured: false })));
      renderTab();

      const banner = screen.getByTestId('moderation-incidents-no-reviewers-banner');
      expect(banner.textContent).toContain('2 incidents are waiting');
      expect(banner.textContent).toContain(
        'No reviewer is emailed until Image Moderation Reviewer Emails in Admin settings, AI Moderation has an address.'
      );
      expect(screen.queryByTestId('moderation-incidents-no-escalation-reviewers-banner')).toBeNull();
      const header = screen.getByTestId('admin-page-header');
      const region = screen.getByTestId('moderation-incidents-summary');
      expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(banner.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('stays quiet about an empty reviewer list when nothing waits', () => {
      m.summary.mockReturnValue(
        summaryReady(totals({ needsReview: 0, oldestPendingCreatedAt: null, reviewersConfigured: false }))
      );
      renderTab();
      expect(screen.queryByTestId('moderation-incidents-no-reviewers-banner')).toBeNull();
    });

    it('says no second reviewer is emailed while escalated incidents wait and that list is empty', () => {
      m.summary.mockReturnValue(summaryReady(totals({ escalated: 1, escalationReviewersConfigured: false })));
      renderTab();

      const banner = screen.getByTestId('moderation-incidents-no-escalation-reviewers-banner');
      expect(banner.textContent).toContain('1 escalated incident is waiting');
      expect(banner.textContent).toContain(
        'No second reviewer is emailed until Image Moderation Escalation Emails in Admin settings, AI Moderation has an address.'
      );
      expect(screen.queryByTestId('moderation-incidents-no-reviewers-banner')).toBeNull();
    });

    it('stays quiet about an empty escalation list when nothing is escalated', () => {
      m.summary.mockReturnValue(summaryReady(totals({ escalated: 0, escalationReviewersConfigured: false })));
      renderTab();
      expect(screen.queryByTestId('moderation-incidents-no-escalation-reviewers-banner')).toBeNull();
    });

    it('shows one banner per list when both are empty', () => {
      m.summary.mockReturnValue(
        summaryReady(totals({ escalated: 1, reviewersConfigured: false, escalationReviewersConfigured: false }))
      );
      renderTab();
      expect(screen.getAllByTestId('moderation-incidents-no-reviewers-banner')).toHaveLength(1);
      expect(screen.getAllByTestId('moderation-incidents-no-escalation-reviewers-banner')).toHaveLength(1);
    });

    it.each([
      ['moderation-incidents-no-reviewers-action-btn', 'ImageModerationReviewerEmails'],
      ['moderation-incidents-no-escalation-reviewers-action-btn', 'ImageModerationEscalationEmails'],
    ])('%s opens Admin settings on the list it names', (button, setting) => {
      m.summary.mockReturnValue(
        summaryReady(totals({ escalated: 1, reviewersConfigured: false, escalationReviewersConfigured: false }))
      );
      renderTab();
      fireEvent.click(screen.getByTestId(button));

      const { to, search } = m.navigate.mock.calls[0][0] as { to: string; search: (prev: object) => object };
      expect(to).toBe('/admin');
      expect(search({ tab: 'moderation-incidents' })).toMatchObject({
        tab: 'admin-settings',
        section: 'security',
        q: setting,
      });
    });
  });
});
