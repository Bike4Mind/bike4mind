import React, { useState, type ReactNode } from 'react';
import { Box, Button, Input, Link, Sheet, Stack, Tab, TabList, TabPanel, Tabs, Tooltip, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  useHelpAnalyticsData,
  type HelpAnalyticsChatFeedback,
  type HelpAnalyticsChatTopic,
  type HelpAnalyticsFeedbackSummary,
  type HelpAnalyticsFilters,
  type HelpAnalyticsRecentFeedback,
  type HelpAnalyticsSearchGap,
  type HelpAnalyticsTopArticle,
} from '@client/app/hooks/data/helpAnalytics';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChip,
  LoadingState,
  SEARCH_TERM_URL_DEBOUNCE_MS,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  type DataColumn,
  type SegmentedOption,
} from '../shared';
import { ADMIN_REGION_GAP, adminFocusScope, adminTabStrip } from '../shared/adminStyles';

/** Truncated text with a tooltip showing the full content on hover */
const HoverText: React.FC<{
  text: string;
  level?: 'body-xs' | 'body-sm';
  maxWidth?: number;
  sx?: SxProps;
}> = ({ text, level = 'body-xs', maxWidth = 300, sx }) => (
  <Tooltip title={text} placement="top-start" variant="outlined" sx={{ maxWidth: 400 }}>
    <Typography
      level={level}
      sx={{
        maxWidth,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        cursor: 'default',
        ...sx,
      }}
    >
      {text}
    </Typography>
  </Tooltip>
);

const NoValue = () => (
  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
    -
  </Typography>
);

const RatingChip: React.FC<{ rating: HelpAnalyticsChatFeedback['rating'] }> = ({ rating }) => (
  <StatusChip tone={rating === 'helpful' ? 'good' : 'bad'} label={rating === 'helpful' ? 'Good' : 'Bad'} />
);

const formatDay = (value: string) => new Date(value).toLocaleDateString();

/** Full chat Q&A with the answer rendered as markdown; the dialog scrolls as a whole. */
const ChatDetailDialog: React.FC<{ item: HelpAnalyticsChatFeedback | null; onClose: () => void }> = ({
  item,
  onClose,
}) => {
  if (!item) return null;
  return (
    <AdminDialog title="Chat feedback" width={700} onClose={onClose} data-testid="help-analytics-chat-dialog">
      <Stack gap={1.5}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <RatingChip rating={item.rating} />
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            {formatDay(item.createdAt)}
          </Typography>
        </Stack>
        {item.comment && (
          <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
            Comment: {item.comment}
          </Typography>
        )}
        <Box>
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            Question
          </Typography>
          <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm' }}>
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
              {item.chatQuestion}
            </Typography>
          </Sheet>
        </Box>
        <Box>
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            Answer
          </Typography>
          <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm' }}>
            <MarkdownViewer content={item.chatAnswer} />
          </Sheet>
        </Box>
      </Stack>
    </AdminDialog>
  );
};

/** Format a Date as YYYY-MM-DD (local time) for date input values */
function toDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

type DatePreset = 'week' | 'month' | 'year' | 'all';
type DateRange = DatePreset | 'custom';

// Four segments at most (DESIGN_GUIDE "Toolkit"), so Custom sits in a Range chip, as on the event
// metrics filter row. While Custom is active no segment is selected.
const RANGE_SEGMENTS: readonly SegmentedOption<DateRange>[] = [
  { value: 'week', label: 'Last week' },
  { value: 'month', label: 'Last month' },
  { value: 'year', label: 'Last year' },
  { value: 'all', label: 'All time' },
];
const RANGE_CHIP_OPTIONS = [{ value: 'custom', label: 'Custom' }] as const;

// Native date inputs accept 5- and 6-digit years, for which the server finds no data; these bounds
// keep the picker to four-digit years.
const MIN_DAY = '2000-01-01';
const MAX_DAY = '9999-12-31';

function getPresetRange(preset: DatePreset): HelpAnalyticsFilters {
  if (preset === 'all') return {};
  const now = new Date();
  const from = new Date();
  if (preset === 'week') from.setDate(now.getDate() - 7);
  else if (preset === 'month') from.setMonth(now.getMonth() - 1);
  else if (preset === 'year') from.setFullYear(now.getFullYear() - 1);
  return { dateFrom: toDateString(from), dateTo: toDateString(now) };
}

type Indexed<Row> = Row & { rowId: string };
/** For lists with no unique field: the server's order is the identity. */
const withRowIds = <Row,>(rows: readonly Row[] | undefined): Indexed<Row>[] =>
  (rows ?? []).map((row, index) => ({ ...row, rowId: String(index) }));

const POPULAR_COLUMNS: DataColumn<HelpAnalyticsTopArticle>[] = [
  {
    id: 'article',
    label: 'Article',
    render: article => (
      <Box sx={{ minWidth: 0 }}>
        <HoverText text={article.title || article.slug} level="body-sm" sx={{ fontWeight: 'md' }} />
        <HoverText text={article.slug} sx={{ color: 'admin.inkMuted' }} />
      </Box>
    ),
  },
  { id: 'views', label: 'Views', numeric: true, width: '8rem', render: article => article.viewCount.toLocaleString() },
];

const SEARCH_GAP_COLUMNS: DataColumn<HelpAnalyticsSearchGap>[] = [
  { id: 'query', label: 'Search query', render: gap => <HoverText text={gap.query} level="body-sm" /> },
  { id: 'count', label: 'Count', numeric: true, width: '6rem', render: gap => gap.count.toLocaleString() },
  { id: 'last', label: 'Last searched', width: '9rem', render: gap => formatDay(gap.lastSearched) },
];

const FEEDBACK_COLUMNS: DataColumn<HelpAnalyticsFeedbackSummary>[] = [
  { id: 'article', label: 'Article', render: item => <HoverText text={item.slug} level="body-sm" /> },
  { id: 'helpful', label: 'Helpful', numeric: true, width: '7rem', render: item => item.helpful.toLocaleString() },
  {
    id: 'not-helpful',
    label: 'Not helpful',
    numeric: true,
    width: '7rem',
    render: item => item.notHelpful.toLocaleString(),
  },
  { id: 'outdated', label: 'Outdated', numeric: true, width: '7rem', render: item => item.outdated.toLocaleString() },
  { id: 'total', label: 'Total', numeric: true, width: '6rem', render: item => item.totalFeedback.toLocaleString() },
];

const reportLabel = (reportType: string) => reportType.charAt(0).toUpperCase() + reportType.slice(1);

const COMMENT_COLUMNS: DataColumn<Indexed<HelpAnalyticsRecentFeedback>>[] = [
  { id: 'article', label: 'Article', render: item => <HoverText text={item.slug} level="body-sm" /> },
  {
    id: 'rating',
    label: 'Rating',
    width: '6rem',
    render: item => (item.rating ? <RatingChip rating={item.rating} /> : <NoValue />),
  },
  {
    id: 'report',
    label: 'Report',
    width: '7rem',
    render: item => (item.reportType ? <StatusChip tone="warn" label={reportLabel(item.reportType)} /> : <NoValue />),
  },
  { id: 'comment', label: 'Comment', render: item => (item.comment ? <HoverText text={item.comment} /> : <NoValue />) },
  { id: 'date', label: 'Date', width: '8rem', render: item => formatDay(item.createdAt) },
];

const QUESTION_COLUMNS: DataColumn<Indexed<HelpAnalyticsChatTopic>>[] = [
  { id: 'question', label: 'Question', render: topic => <HoverText text={topic.question} level="body-sm" /> },
  { id: 'count', label: 'Count', numeric: true, width: '6rem', render: topic => topic.count.toLocaleString() },
  { id: 'last', label: 'Last asked', width: '9rem', render: topic => formatDay(topic.lastAsked) },
];

const chatFeedbackColumns = (
  onView: (item: HelpAnalyticsChatFeedback) => void
): DataColumn<Indexed<HelpAnalyticsChatFeedback>>[] => [
  { id: 'question', label: 'Question', render: item => <HoverText text={item.chatQuestion} maxWidth={200} /> },
  {
    id: 'answer',
    label: 'Answer',
    width: '6rem',
    render: item => (
      <Link component="button" level="body-xs" onClick={() => onView(item)} data-testid="chat-feedback-view-btn">
        View
      </Link>
    ),
  },
  { id: 'rating', label: 'Rating', width: '6rem', render: item => <RatingChip rating={item.rating} /> },
  { id: 'comment', label: 'Comment', render: item => (item.comment ? <HoverText text={item.comment} /> : <NoValue />) },
  { id: 'date', label: 'Date', width: '8rem', render: item => formatDay(item.createdAt) },
];

const TAB_PANEL_SX = { p: 0, pt: 2 };

const PanelDescription: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

const HelpAnalyticsTab: React.FC = () => {
  const [range, setRange] = useState<DateRange>('week');
  const {
    value: filters,
    debouncedValue: appliedFilters,
    setValue: setFilters,
    setValueImmediately: applyFilters,
  } = useDebounceValue<HelpAnalyticsFilters>(getPresetRange('week'), SEARCH_TERM_URL_DEBOUNCE_MS);
  const { data, isLoading, isError, isFetching, refetch } = useHelpAnalyticsData(appliedFilters);
  const [chatDetailItem, setChatDetailItem] = useState<HelpAnalyticsChatFeedback | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  const pickRange = (next: DateRange) => {
    setRange(next);
    if (next !== 'custom') applyFilters(getPresetRange(next));
  };
  const refresh = () => void refetch();

  const emptyState = (title: string) =>
    range === 'all' ? (
      <EmptyState
        title={title}
        action={
          <Button variant="outlined" onClick={refresh} data-testid="help-analytics-empty-refresh-btn">
            Refresh
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={title}
        description="Nothing was recorded in this date range."
        action={
          <Button variant="outlined" onClick={() => pickRange('all')} data-testid="help-analytics-clear-range-btn">
            Clear date range
          </Button>
        }
      />
    );

  const overview = data?.overview;

  // LoadingState only on a first load: a range change keeps the previous numbers (placeholder data)
  // and refetches under the UpdatingBar.
  let body: ReactNode;
  if (isLoading) body = <LoadingState label="Loading help analytics" />;
  else if (isError && !data)
    body = <ErrorState message="Help analytics failed to load." onRetry={refresh} retrying={isFetching} />;
  else
    body = (
      <>
        <UpdatingBar active={isFetching} testId="help-analytics-updating" />
        {overview && (
          <StatStrip aria-label="Help usage totals">
            <StatTile label="Total views" value={overview.totalViews} />
            <StatTile label="Unique articles" value={overview.uniqueArticlesViewed} />
            <StatTile label="Total searches" value={overview.totalSearches} />
            <StatTile label="Article feedback" value={overview.totalFeedback} />
            <StatTile label="Chat queries" value={overview.totalChatQueries} />
            <StatTile label="Chat feedback" value={overview.totalChatFeedback} />
          </StatStrip>
        )}

        <Tabs value={activeTab} onChange={(_event, value) => setActiveTab(value as number)}>
          <TabList sx={adminTabStrip}>
            <Tab data-testid="help-analytics-tab-popular">Popular articles</Tab>
            <Tab data-testid="help-analytics-tab-search-gaps">Search gaps</Tab>
            <Tab data-testid="help-analytics-tab-article-feedback">Article feedback</Tab>
            <Tab data-testid="help-analytics-tab-article-comments">Article comments</Tab>
            <Tab data-testid="help-analytics-tab-recent-questions">Recent questions</Tab>
            <Tab data-testid="help-analytics-tab-chat-feedback">Chat feedback</Tab>
          </TabList>

          <TabPanel value={0} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>Most viewed help articles, ranked by views</PanelDescription>
              <DataTable
                rows={data?.topArticles ?? []}
                columns={POPULAR_COLUMNS}
                getRowId={article => article.slug}
                label="Popular articles"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No article views')}
                testId="help-analytics-popular-table"
              />
            </Stack>
          </TabPanel>

          <TabPanel value={1} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>Searches that returned no results, which point to documentation gaps</PanelDescription>
              <DataTable
                rows={data?.searchGaps ?? []}
                columns={SEARCH_GAP_COLUMNS}
                getRowId={gap => gap.query}
                label="Search gaps"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No searches without results')}
                testId="help-analytics-search-gaps-table"
              />
            </Stack>
          </TabPanel>

          <TabPanel value={2} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>
                Ratings per article; start with articles that have many Not helpful or Outdated votes
              </PanelDescription>
              <DataTable
                rows={data?.feedbackSummary ?? []}
                columns={FEEDBACK_COLUMNS}
                getRowId={item => item.slug}
                label="Article feedback"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No article feedback')}
                testId="help-analytics-article-feedback-table"
              />
            </Stack>
          </TabPanel>

          <TabPanel value={3} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>Recent individual feedback with comments and outdated reports</PanelDescription>
              <DataTable
                rows={withRowIds(data?.recentFeedback)}
                columns={COMMENT_COLUMNS}
                getRowId={item => item.rowId}
                label="Article comments"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No article comments')}
                testId="help-analytics-article-comments-table"
              />
            </Stack>
          </TabPanel>

          <TabPanel value={4} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>
                Most common help chat questions; frequent topics may need their own article
              </PanelDescription>
              <DataTable
                rows={withRowIds(data?.chatTopics)}
                columns={QUESTION_COLUMNS}
                getRowId={topic => topic.rowId}
                label="Recent questions"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No chat questions')}
                testId="help-analytics-recent-questions-table"
              />
            </Stack>
          </TabPanel>

          <TabPanel value={5} sx={TAB_PANEL_SX}>
            <Stack gap={1}>
              <PanelDescription>
                Feedback on help chat answers, to improve the system prompt and retrieval
              </PanelDescription>
              <DataTable
                rows={withRowIds(data?.chatFeedback)}
                columns={chatFeedbackColumns(setChatDetailItem)}
                getRowId={item => item.rowId}
                label="Chat feedback"
                onRetry={refresh}
                pagination={false}
                empty={emptyState('No chat feedback')}
                testId="help-analytics-chat-feedback-table"
              />
            </Stack>
          </TabPanel>
        </Tabs>
      </>
    );

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Help analytics"
        description="Help article views, searches and feedback, and questions asked in the help chat."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon />}
              loading={isFetching}
              onClick={refresh}
              data-testid="help-analytics-refresh-btn"
            >
              Refresh
            </Button>
            <ContextHelpButton helpId="admin/help-analytics" tooltipText="Help analytics help" />
          </>
        }
      />

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={1}
        sx={adminFocusScope}
        data-testid="help-analytics-filter-row"
      >
        <SegmentedControl
          options={RANGE_SEGMENTS}
          value={range}
          onChange={pickRange}
          aria-label="Date range"
          data-testid="help-analytics-range"
        />
        <FilterChip
          id="help-range"
          label="Range"
          value={range === 'custom' ? 'custom' : undefined}
          options={RANGE_CHIP_OPTIONS}
          onChange={value => pickRange(value === 'custom' ? 'custom' : 'all')}
        />
        {range === 'custom' && (
          <>
            <Input
              size="sm"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={event => setFilters({ ...filters, dateFrom: event.target.value || undefined })}
              slotProps={{
                input: {
                  'aria-label': 'From',
                  min: MIN_DAY,
                  max: filters.dateTo || MAX_DAY,
                  'data-testid': 'help-analytics-date-from',
                },
              }}
            />
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              to
            </Typography>
            <Input
              size="sm"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={event => setFilters({ ...filters, dateTo: event.target.value || undefined })}
              slotProps={{
                input: {
                  'aria-label': 'To',
                  min: filters.dateFrom || MIN_DAY,
                  max: MAX_DAY,
                  'data-testid': 'help-analytics-date-to',
                },
              }}
            />
          </>
        )}
      </Stack>

      {body}

      <ChatDetailDialog item={chatDetailItem} onClose={() => setChatDetailItem(null)} />
    </Stack>
  );
};

export default HelpAnalyticsTab;
