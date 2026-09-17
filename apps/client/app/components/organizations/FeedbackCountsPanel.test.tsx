import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useOrgFeedbackReport = vi.hoisted(() => vi.fn());
const useOrgFeedbackItems = vi.hoisted(() => vi.fn());
const useOrgFeedbackItem = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/orgFeedbackReport', () => ({
  useOrgFeedbackReport,
  useOrgFeedbackItems,
  useOrgFeedbackItem,
}));

import FeedbackCountsPanel from './FeedbackCountsPanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const REPORT = {
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  totals: { count: 3 },
  byDay: [{ day: '2026-01-10', count: 3 }],
  bySubject: [{ key: 'product', count: 3 }],
  byType: [{ key: 'Bug', count: 3 }],
  byStatus: [{ key: 'New', count: 3 }],
  byTag: [],
  byMember: [{ userId: 'u1', displayName: 'Alice', count: 3 }],
  membership: { memberCount: 1, aclOnly: [], stampOnly: [] },
};

const ITEM = {
  id: 'f1',
  createdAt: '2026-01-10T12:00:00.000Z',
  userId: 'u1',
  username: 'alice',
  subject: 'product',
  status: 'New',
  type: 'Bug',
  tags: ['billing'],
  contentStored: true,
};

const idle = { data: undefined, isFetching: false, isError: false, error: null };

const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FeedbackCountsPanel organizationId="org1" range={{ from: '2026-01-01', to: '2026-01-31' }} />
    </CssVarsProvider>
  );

/**
 * The counts are only half the promise: a count nobody can open is a number with no way to check
 * it. What is pinned here is that a By subject cell is a real control, that opening one asks the
 * list route for THAT subject over the same window, and that a row carries no feedback text.
 */
describe('FeedbackCountsPanel drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgFeedbackReport.mockReturnValue({ ...idle, data: REPORT });
    useOrgFeedbackItems.mockReturnValue({ ...idle, data: { items: [ITEM], total: 1, limit: 25, offset: 0 } });
    useOrgFeedbackItem.mockReturnValue({ ...idle, data: ITEM });
  });

  it('does not fetch any rows until a count is opened', () => {
    renderPanel();

    expect(screen.queryByTestId('org-analysis-drilldown')).toBeNull();
    expect(useOrgFeedbackItems).not.toHaveBeenCalled();
  });

  it('opens the rows behind a subject count, scoped to that subject and the same window', () => {
    renderPanel();

    fireEvent.click(screen.getByTestId('org-analysis-by-subject-row-product'));

    expect(screen.getByTestId('org-analysis-drilldown')).toBeTruthy();
    expect(useOrgFeedbackItems).toHaveBeenLastCalledWith('org1', { from: '2026-01-01', to: '2026-01-31' }, 'product');
  });

  it('opens one row into metadata only, never the feedback text', () => {
    renderPanel();

    fireEvent.click(screen.getByTestId('org-analysis-by-subject-row-product'));
    fireEvent.click(screen.getByTestId('org-analysis-drilldown-row-f1'));

    expect(useOrgFeedbackItem).toHaveBeenLastCalledWith('org1', 'f1');
    const detail = screen.getByTestId('org-analysis-item-detail');
    expect(detail.textContent).toContain('alice');
    expect(screen.getByTestId('org-analysis-item-content-note').textContent).toContain('not shown here');
  });

  it('closes the drill-down when the same count is clicked again', () => {
    renderPanel();

    fireEvent.click(screen.getByTestId('org-analysis-by-subject-row-product'));
    fireEvent.click(screen.getByTestId('org-analysis-by-subject-row-product'));

    expect(screen.queryByTestId('org-analysis-drilldown')).toBeNull();
  });

  it('leaves the groupings the list route cannot filter by as plain rows', () => {
    renderPanel();

    expect(screen.queryByTestId('org-analysis-by-status-row-New')).toBeNull();
    expect(screen.queryByTestId('org-analysis-by-type-row-Bug')).toBeNull();
  });
});
