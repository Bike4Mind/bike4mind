import React, { useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  DialogTitle,
  Divider,
  Input,
  LinearProgress,
  Link,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import VisibilityIcon from '@mui/icons-material/Visibility';
import SearchIcon from '@mui/icons-material/Search';
import ThumbsUpDownIcon from '@mui/icons-material/ThumbsUpDown';
import ChatIcon from '@mui/icons-material/Chat';
import ArticleIcon from '@mui/icons-material/Article';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import {
  useHelpAnalyticsData,
  HelpAnalyticsFilters,
  HelpAnalyticsChatFeedback,
} from '@client/app/hooks/data/helpAnalytics';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';

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

/** Modal for viewing full chat Q&A with rendered markdown */
const ChatDetailModal: React.FC<{
  item: HelpAnalyticsChatFeedback | null;
  open: boolean;
  onClose: () => void;
}> = ({ item, open, onClose }) => {
  if (!item) return null;
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 700, height: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ModalClose />
        <DialogTitle sx={{ flexShrink: 0 }}>Chat Feedback Detail</DialogTitle>

        {/* Scrollable Q&A body - question gets a capped region, answer gets the rest */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: 1.5, py: 1 }}>
          {/* Question - scrolls independently, capped at ~4 lines */}
          <Box sx={{ flexShrink: 0 }}>
            <Typography level="title-sm" sx={{ mb: 0.5 }}>
              Question
            </Typography>
            <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', maxHeight: '6em', overflow: 'auto' }}>
              <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                {item.chatQuestion}
              </Typography>
            </Sheet>
          </Box>

          {/* Answer - takes remaining space, scrolls independently */}
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography level="title-sm" sx={{ mb: 0.5, flexShrink: 0 }}>
              Answer
            </Typography>
            <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', flex: 1, overflow: 'auto', minHeight: 0 }}>
              <MarkdownViewer content={item.chatAnswer} />
            </Sheet>
          </Box>
        </Box>

        {/* Fixed footer - rating, comment, date */}
        <Divider sx={{ flexShrink: 0 }} />
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, pt: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              Rating:
            </Typography>
            <Chip
              size="sm"
              color={item.rating === 'helpful' ? 'success' : 'danger'}
              variant={item.rating === 'helpful' ? 'soft' : 'outlined'}
            >
              {item.rating === 'helpful' ? 'Good' : 'Bad'}
            </Chip>
          </Box>
          {item.comment && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flex: 1, minWidth: 0 }}>
              <Typography level="body-xs" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                Comment:
              </Typography>
              <Typography level="body-xs" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.comment}
              </Typography>
            </Box>
          )}
          <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
            {new Date(item.createdAt).toLocaleDateString()}
          </Typography>
        </Box>
      </ModalDialog>
    </Modal>
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

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'week', label: 'Last Week' },
  { key: 'month', label: 'Last Month' },
  { key: 'year', label: 'Last Year' },
  { key: 'all', label: 'All Time' },
];

function getPresetRange(preset: DatePreset): HelpAnalyticsFilters {
  if (preset === 'all') return {};
  const now = new Date();
  const from = new Date();
  if (preset === 'week') from.setDate(now.getDate() - 7);
  else if (preset === 'month') from.setMonth(now.getMonth() - 1);
  else if (preset === 'year') from.setFullYear(now.getFullYear() - 1);
  return { dateFrom: toDateString(from), dateTo: toDateString(now) };
}

const HelpAnalyticsTab: React.FC = () => {
  // Default to last 7 days
  const [activePreset, setActivePreset] = useState<DatePreset | null>('week');
  const [filters, setFilters] = useState<HelpAnalyticsFilters>(() => getPresetRange('week'));
  const { data, isLoading } = useHelpAnalyticsData(filters);
  const [chatDetailItem, setChatDetailItem] = useState<HelpAnalyticsChatFeedback | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  const overview = data?.overview;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography level="h3">Help Center Analytics</Typography>
        <ContextHelpButton helpId="admin/help-analytics" tooltipText="Help Analytics Help" />
      </Box>

      {/* Date filters */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: { xs: 1, sm: 2 },
          mb: 3,
          flexWrap: 'wrap',
        }}
      >
        <Typography level="body-sm" sx={{ color: 'text.secondary', fontWeight: 'md' }}>
          Date range:
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {DATE_PRESETS.map(({ key, label }) => (
            <Button
              key={key}
              size="sm"
              variant={activePreset === key ? 'solid' : 'outlined'}
              color={activePreset === key ? 'primary' : 'neutral'}
              onClick={() => {
                setActivePreset(key);
                setFilters(getPresetRange(key));
              }}
              data-testid={`help-analytics-preset-${key}`}
            >
              {label}
            </Button>
          ))}
        </Box>
        <Input
          type="date"
          size="sm"
          startDecorator={<Typography level="body-xs">From</Typography>}
          value={filters.dateFrom || ''}
          onChange={e => {
            setActivePreset(null);
            setFilters(f => ({ ...f, dateFrom: e.target.value || undefined }));
          }}
          data-testid="help-analytics-date-from"
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        />
        <Input
          type="date"
          size="sm"
          startDecorator={<Typography level="body-xs">To</Typography>}
          value={filters.dateTo || ''}
          onChange={e => {
            setActivePreset(null);
            setFilters(f => ({ ...f, dateTo: e.target.value || undefined }));
          }}
          data-testid="help-analytics-date-to"
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        />
      </Box>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Overview stat cards - click to jump to the corresponding tab */}
      {overview && (
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
          <StatCard
            icon={<VisibilityIcon />}
            label="Total Views"
            value={overview.totalViews}
            onClick={() => setActiveTab(0)}
            active={activeTab === 0}
          />
          <StatCard
            icon={<ArticleIcon />}
            label="Unique Articles"
            value={overview.uniqueArticlesViewed}
            onClick={() => setActiveTab(0)}
            active={activeTab === 0}
          />
          <StatCard
            icon={<SearchIcon />}
            label="Total Searches"
            value={overview.totalSearches}
            onClick={() => setActiveTab(1)}
            active={activeTab === 1}
          />
          <StatCard
            icon={<ThumbsUpDownIcon />}
            label="Article Feedback"
            value={overview.totalFeedback}
            onClick={() => setActiveTab(2)}
            active={activeTab === 2}
          />
          <StatCard
            icon={<ChatIcon />}
            label="Chat Queries"
            value={overview.totalChatQueries}
            onClick={() => setActiveTab(4)}
            active={activeTab === 4}
          />
          <StatCard
            icon={<SmartToyIcon />}
            label="Chat Feedback"
            value={overview.totalChatFeedback}
            onClick={() => setActiveTab(5)}
            active={activeTab === 5}
          />
        </Box>
      )}

      {/* Sub-tabs */}
      <Tabs value={activeTab} onChange={(_e, val) => setActiveTab(val as number)}>
        <TabList sx={{ overflowX: { xs: 'auto', sm: 'unset' }, flexWrap: { xs: 'nowrap', sm: 'wrap' } }}>
          <Tab data-testid="help-analytics-tab-popular" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Popular Articles
          </Tab>
          <Tab data-testid="help-analytics-tab-search-gaps" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Search Gaps
          </Tab>
          <Tab data-testid="help-analytics-tab-article-feedback" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Article Feedback
          </Tab>
          <Tab data-testid="help-analytics-tab-article-comments" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Article Comments
          </Tab>
          <Tab data-testid="help-analytics-tab-recent-questions" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Recent Questions
          </Tab>
          <Tab data-testid="help-analytics-tab-chat-feedback" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            Chat Feedback
          </Tab>
        </TabList>

        {/* Popular Articles */}
        <TabPanel value={0}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            Most-viewed help articles ranked by total views
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '480px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Article</th>
                  <th style={{ width: 100 }}>Views</th>
                </tr>
              </thead>
              <tbody>
                {data?.topArticles?.length ? (
                  data.topArticles.map(article => (
                    <tr key={article.slug}>
                      <td>
                        <HoverText text={article.title || article.slug} level="body-sm" sx={{ fontWeight: 'md' }} />
                        <HoverText text={article.slug} sx={{ color: 'text.tertiary' }} />
                      </td>
                      <td>
                        <Typography level="body-sm">{article.viewCount}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={2}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No article views yet
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>

        {/* Search Gaps */}
        <TabPanel value={1}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            Searches that returned 0 results — identifies documentation gaps
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '560px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Search Query</th>
                  <th style={{ width: 80 }}>Count</th>
                  <th style={{ width: 140 }}>Last Searched</th>
                </tr>
              </thead>
              <tbody>
                {data?.searchGaps?.length ? (
                  data.searchGaps.map(gap => (
                    <tr key={gap.query}>
                      <td>
                        <HoverText text={gap.query} level="body-sm" />
                      </td>
                      <td>
                        <Typography level="body-sm">{gap.count}</Typography>
                      </td>
                      <td>
                        <Typography level="body-xs">{new Date(gap.lastSearched).toLocaleDateString()}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No search gaps found
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>

        {/* Article Feedback */}
        <TabPanel value={2}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            Per-article rating breakdown &mdash; prioritize articles with high &ldquo;Not Helpful&rdquo; or
            &ldquo;Outdated&rdquo; counts
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '700px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Article</th>
                  <th style={{ width: 80 }}>Helpful</th>
                  <th style={{ width: 100 }}>Not Helpful</th>
                  <th style={{ width: 80 }}>Outdated</th>
                  <th style={{ width: 80 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {data?.feedbackSummary?.length ? (
                  data.feedbackSummary.map(item => (
                    <tr key={item.slug}>
                      <td>
                        <HoverText text={item.slug} level="body-sm" />
                      </td>
                      <td>
                        <Chip size="sm" color="success" variant="soft">
                          {item.helpful}
                        </Chip>
                      </td>
                      <td>
                        <Chip size="sm" color="danger" variant="outlined">
                          {item.notHelpful}
                        </Chip>
                      </td>
                      <td>
                        <Chip size="sm" color="warning" variant="soft">
                          {item.outdated}
                        </Chip>
                      </td>
                      <td>
                        <Typography level="body-sm">{item.totalFeedback}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No article feedback yet
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>

        {/* Article Comments */}
        <TabPanel value={3}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            Recent individual feedback entries with comments and outdated reports
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '720px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Article</th>
                  <th style={{ width: 80 }}>Rating</th>
                  <th style={{ width: 80 }}>Report</th>
                  <th>Comment</th>
                  <th style={{ width: 120 }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {data?.recentFeedback?.length ? (
                  data.recentFeedback.map(item => (
                    <tr key={`${item.slug}-${item.createdAt}`}>
                      <td>
                        <HoverText text={item.slug} level="body-sm" />
                      </td>
                      <td>
                        {item.rating && (
                          <Chip size="sm" color={item.rating === 'helpful' ? 'success' : 'danger'} variant="soft">
                            {item.rating === 'helpful' ? 'Good' : 'Bad'}
                          </Chip>
                        )}
                      </td>
                      <td>
                        {item.reportType && (
                          <Chip size="sm" color="warning" variant="soft">
                            {item.reportType}
                          </Chip>
                        )}
                      </td>
                      <td>
                        {item.comment ? <HoverText text={item.comment} /> : <Typography level="body-xs">-</Typography>}
                      </td>
                      <td>
                        <Typography level="body-xs">{new Date(item.createdAt).toLocaleDateString()}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No article comments yet
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>

        {/* Recent Questions */}
        <TabPanel value={4}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            Most common AI chat questions — frequent topics may need dedicated help articles
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '560px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Question</th>
                  <th style={{ width: 80 }}>Count</th>
                  <th style={{ width: 140 }}>Last Asked</th>
                </tr>
              </thead>
              <tbody>
                {data?.chatTopics?.length ? (
                  data.chatTopics.map((topic, idx) => (
                    <tr key={`${topic.question}-${idx}`}>
                      <td>
                        <HoverText text={topic.question} level="body-sm" />
                      </td>
                      <td>
                        <Typography level="body-sm">{topic.count}</Typography>
                      </td>
                      <td>
                        <Typography level="body-xs">{new Date(topic.lastAsked).toLocaleDateString()}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No chat queries yet
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>

        {/* Chat Feedback */}
        <TabPanel value={5}>
          <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
            User feedback on AI chat responses — helps improve the system prompt and RAG lookups
          </Typography>
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stripe="odd" size="sm" sx={{ minWidth: { xs: '720px', sm: 'auto' } }}>
              <thead>
                <tr>
                  <th>Question</th>
                  <th style={{ width: 80 }}>Answer</th>
                  <th style={{ width: 80 }}>Rating</th>
                  <th>Comment</th>
                  <th style={{ width: 120 }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {data?.chatFeedback?.length ? (
                  data.chatFeedback.map(item => (
                    <tr key={`${item.chatQuestion}-${item.createdAt}`}>
                      <td>
                        <HoverText text={item.chatQuestion} maxWidth={200} />
                      </td>
                      <td>
                        <Link
                          component="button"
                          level="body-xs"
                          onClick={() => setChatDetailItem(item)}
                          data-testid="chat-feedback-view-btn"
                        >
                          View
                        </Link>
                      </td>
                      <td>
                        <Chip
                          size="sm"
                          color={item.rating === 'helpful' ? 'success' : 'danger'}
                          variant={item.rating === 'helpful' ? 'soft' : 'outlined'}
                        >
                          {item.rating === 'helpful' ? 'Good' : 'Bad'}
                        </Chip>
                      </td>
                      <td>
                        {item.comment ? <HoverText text={item.comment} /> : <Typography level="body-xs">-</Typography>}
                      </td>
                      <td>
                        <Typography level="body-xs">{new Date(item.createdAt).toLocaleDateString()}</Typography>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: 2 }}>
                        No chat feedback yet
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>
      </Tabs>

      <ChatDetailModal item={chatDetailItem} open={chatDetailItem !== null} onClose={() => setChatDetailItem(null)} />
    </Box>
  );
};

/** Stat card, optionally clickable to jump to a tab */
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  onClick?: () => void;
  active?: boolean;
}> = ({ icon, label, value, onClick, active }) => (
  <Card
    variant="outlined"
    sx={{
      minWidth: 140,
      flex: '1 1 140px',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'border-color 0.15s, box-shadow 0.15s',
      ...(active && {
        borderColor: 'primary.400',
        boxShadow: 'sm',
      }),
      '&:hover': onClick
        ? {
            borderColor: 'primary.300',
            boxShadow: 'sm',
          }
        : {},
    }}
    onClick={onClick}
    data-testid={`help-analytics-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Box sx={{ color: 'primary.500', display: 'flex' }}>{icon}</Box>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
    </Box>
    <Typography level="h3">{value.toLocaleString()}</Typography>
  </Card>
);

export default HelpAnalyticsTab;
