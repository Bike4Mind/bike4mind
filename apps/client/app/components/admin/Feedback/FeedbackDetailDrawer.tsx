import type { ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Option,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import ForumIcon from '@mui/icons-material/Forum';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LinkIcon from '@mui/icons-material/Link';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import PersonIcon from '@mui/icons-material/Person';
import { useQuery } from '@tanstack/react-query';
import { adminUserProfilePath, FeedbackStatus } from '@bike4mind/common';
import { getFeedbackByIdFromServer } from '@client/app/utils/feedbackAPICalls';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { openHelpPanel, useHelpPanel } from '@client/app/hooks/useHelpPanel';
import { Fact, SectionCard, StatusChip } from '../shared';
import { adminFocus, adminFocusScope } from '../shared/adminStyles';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import UserIdChip from '../Users/UserIdChip';
import { getFeedbackDisplayContent, type IExtendedFeedbackDocument } from './types';
import { feedbackRecordQueryKey } from './queryKeys';
import { copyFeedbackRecordLink, feedbackConversationPath, feedbackReporterMailto } from './feedbackLinks';
import HelpContextChip from './HelpContextChip';
import ClientContextChips from './ClientContextChips';
import { FEEDBACK_STATUS_LABELS, FEEDBACK_STATUS_ORDER, FEEDBACK_SUBJECT_LABELS } from './constants';
import { summarizePromptMeta } from './promptMetaSummary';

const STATUS_TONES: Record<FeedbackStatus, AdminStatusTone> = {
  [FeedbackStatus.New]: 'info',
  [FeedbackStatus.InProgress]: 'warn',
  [FeedbackStatus.Closed]: 'neutral',
};

const formatDateTime = (value: Date | string) =>
  new Date(value).toLocaleString('default', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatCount = (value: number | undefined) => (value === undefined ? undefined : value.toLocaleString());

export interface FeedbackDetailDrawerProps {
  /** The `?feedbackId=` in the URL; undefined keeps the drawer closed. */
  feedbackId: string | undefined;
  /** The row as the list has it, shown while the full record (with `promptMeta`) loads. */
  listRow?: IExtendedFeedbackDocument;
  /** 1-based place of this report in the filtered, sorted list; absent when it is not in the list. */
  position?: { index: number; total: number };
  /** Absent at either end of the list, which disables the button. */
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onStatusChange: (feedbackItem: IExtendedFeedbackDocument, status: FeedbackStatus | null) => Promise<void>;
}

/**
 * One feedback report in full: text, reporter, links out, the turn's model and tools, and status.
 *
 * Read by id rather than taken from the list: the list projection leaves out `promptMeta`, and a
 * shared link can name a report that is not on the current page or does not match the filters.
 */
const FeedbackDetailDrawer = ({
  feedbackId,
  listRow,
  position,
  onPrevious,
  onNext,
  onClose,
  onStatusChange,
}: FeedbackDetailDrawerProps) => {
  const recordQuery = useQuery({
    queryKey: feedbackRecordQueryKey(feedbackId ?? ''),
    queryFn: () => getFeedbackByIdFromServer(feedbackId!),
    enabled: Boolean(feedbackId),
    placeholderData: listRow && listRow._id === feedbackId ? listRow : undefined,
  });

  const helpPanelOpen = useHelpPanel(state => state.open);

  const record = recordQuery.data ?? undefined;
  const missing = recordQuery.isError || (recordQuery.isSuccess && !recordQuery.data);

  return (
    <Drawer
      anchor="right"
      open={Boolean(feedbackId)}
      onClose={onClose}
      // The tab moves focus back to the report's row itself: after previous/next, the row focused
      // before opening is no longer the one being read.
      disableRestoreFocus
      // "Open the help article" opens the help panel beside the drawer; a trapped focus would make
      // that panel unusable, so focus is only trapped while the panel is closed.
      disableEnforceFocus={helpPanelOpen}
      slotProps={{
        content: {
          'aria-labelledby': 'feedback-detail-title',
          sx: {
            width: { xs: '100%', md: 'min(40rem, 100%)' },
            bgcolor: 'admin.surface',
            color: 'admin.ink',
            boxShadow: 'lg',
            p: 0,
          },
        },
      }}
      data-testid="feedback-detail-drawer"
    >
      <Stack sx={{ height: '100%', minHeight: 0, ...adminFocusScope }}>
        <Stack
          direction="row"
          alignItems="center"
          gap={1}
          sx={{ px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'admin.border' }}
        >
          <Typography id="feedback-detail-title" level="title-lg" component="h2" sx={{ mr: 'auto' }}>
            Feedback report
          </Typography>
          {position && (
            <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="feedback-detail-position">
              {position.index} of {position.total}
            </Typography>
          )}
          <Tooltip title="Previous report">
            <span>
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Previous report"
                disabled={!onPrevious}
                onClick={onPrevious}
                sx={adminFocus}
                data-testid="feedback-detail-previous-btn"
              >
                <KeyboardArrowUpIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Next report">
            <span>
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Next report"
                disabled={!onNext}
                onClick={onNext}
                sx={adminFocus}
                data-testid="feedback-detail-next-btn"
              >
                <KeyboardArrowDownIcon />
              </IconButton>
            </span>
          </Tooltip>
          {feedbackId && (
            <Tooltip title="Copy link to this report">
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Copy link to this report"
                onClick={() => void copyFeedbackRecordLink(feedbackId)}
                sx={adminFocus}
                data-testid="feedback-detail-copy-link-btn"
              >
                <LinkIcon />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Close">
            <IconButton
              size="sm"
              variant="plain"
              aria-label="Close"
              onClick={onClose}
              sx={adminFocus}
              data-testid="feedback-detail-close-btn"
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2.5, py: 2 }}>
          {recordQuery.isLoading && !record && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size="sm" data-testid="feedback-detail-loading" />
            </Box>
          )}

          {/* The read route answers NotFound whether the report is gone or not the caller's, so this
              copy covers both rather than guessing. */}
          {missing && (
            <Alert color="warning" size="sm" data-testid="feedback-detail-missing">
              This report is no longer available, or you do not have access to it.
            </Alert>
          )}

          {record && !missing && (
            <FeedbackDetailBody
              record={record}
              promptMetaLoading={recordQuery.isPlaceholderData && Boolean(record.questId || record.sessionId)}
              onStatusChange={onStatusChange}
            />
          )}
        </Box>
      </Stack>
    </Drawer>
  );
};

const FeedbackDetailBody = ({
  record,
  promptMetaLoading,
  onStatusChange,
}: {
  record: IExtendedFeedbackDocument;
  promptMetaLoading: boolean;
  onStatusChange: FeedbackDetailDrawerProps['onStatusChange'];
}) => {
  const conversationPath = feedbackConversationPath(record);
  const helpSlug = record.helpContext?.surface === 'article' ? record.helpContext.slug : undefined;
  const organization = record.organization && record.organization !== 'Unknown' ? record.organization : undefined;
  const turn = summarizePromptMeta(record.promptMeta);
  const reporterMailto = feedbackReporterMailto(record);

  return (
    <Stack gap={2}>
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
        <StatusChip
          tone={STATUS_TONES[record.status] ?? 'neutral'}
          label={FEEDBACK_STATUS_LABELS[record.status] ?? record.status}
          dot
          data-testid="feedback-detail-status-chip"
        />
        {record.type && (
          <Chip size="sm" variant="outlined" data-testid="feedback-detail-type">
            {record.type}
          </Chip>
        )}
        <Chip size="sm" variant="soft" data-testid="feedback-detail-subject">
          {FEEDBACK_SUBJECT_LABELS[record.subject] ?? record.subject}
        </Chip>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {relativeTimeFormat(new Date(record.createdAt))}
        </Typography>
      </Stack>

      <Stack gap={1}>
        <HelpContextChip feedbackItem={record} />
        <ClientContextChips feedbackItem={record} />
        {record.contentTruncated && (
          <StatusChip tone="warn" label="Truncated" data-testid="feedback-detail-truncated-badge" />
        )}
        <Typography
          level="body-md"
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'admin.ink' }}
          data-testid="feedback-detail-content"
        >
          {getFeedbackDisplayContent(record, 'No comment was left with this report.')}
        </Typography>
        {record.tags && record.tags.length > 0 && (
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {record.tags.map((tag, index) => (
              <Chip key={`${tag}-${index}`} size="sm" variant="soft" color="neutral">
                {tag}
              </Chip>
            ))}
          </Stack>
        )}
      </Stack>

      {(conversationPath || helpSlug) && (
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {conversationPath && (
            <Button
              size="sm"
              variant="outlined"
              component="a"
              href={conversationPath}
              target="_blank"
              rel="noopener noreferrer"
              startDecorator={<ForumIcon sx={{ fontSize: 16 }} />}
              sx={adminFocus}
              data-testid="feedback-detail-open-conversation-btn"
            >
              {record.questId ? 'Open conversation at this turn' : 'Open the conversation'}
            </Button>
          )}
          {helpSlug && (
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<MenuBookIcon sx={{ fontSize: 16 }} />}
              onClick={() => openHelpPanel(helpSlug)}
              sx={adminFocus}
              data-testid="feedback-detail-open-article-btn"
            >
              Open the help article
            </Button>
          )}
        </Stack>
      )}

      <SectionCard
        title="Reporter"
        data-testid="feedback-detail-reporter"
        action={
          record.userId || reporterMailto ? (
            <Stack direction="row" flexWrap="wrap" gap={0.5}>
              {reporterMailto && (
                <Button
                  size="sm"
                  variant="plain"
                  component="a"
                  href={reporterMailto}
                  startDecorator={<MailOutlineIcon sx={{ fontSize: 16 }} />}
                  sx={adminFocus}
                  data-testid="feedback-detail-email-reporter-btn"
                >
                  Email reporter
                </Button>
              )}
              {record.userId && (
                <Button
                  size="sm"
                  variant="plain"
                  component="a"
                  href={adminUserProfilePath(record.userId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  startDecorator={<PersonIcon sx={{ fontSize: 16 }} />}
                  sx={adminFocus}
                  data-testid="feedback-detail-reporter-profile-btn"
                >
                  Open profile
                </Button>
              )}
            </Stack>
          ) : undefined
        }
      >
        <Fact label="Name">{record.username}</Fact>
        <Fact label="Email">{record.userEmail}</Fact>
        <Fact label="Organization">{organization}</Fact>
        <Fact label="User id">{record.userId ? <UserIdChip userId={record.userId} /> : undefined}</Fact>
      </SectionCard>

      {(turn || promptMetaLoading) && (
        <SectionCard title="This turn" data-testid="feedback-detail-turn">
          {promptMetaLoading && !turn ? (
            <Fact label="Model">
              <CircularProgress size="sm" data-testid="feedback-detail-turn-loading" />
            </Fact>
          ) : (
            turn && <TurnFacts turn={turn} />
          )}
        </SectionCard>
      )}

      <SectionCard title="Status" data-testid="feedback-detail-status">
        <Fact label="Status">
          <Select
            size="sm"
            value={record.status}
            onChange={(_, value) => {
              if (value) void onStatusChange(record, value);
            }}
            slotProps={{
              button: { 'aria-label': 'Status of this report', 'data-testid': 'feedback-detail-status-select' },
              listbox: { sx: { zIndex: 1400 } },
            }}
            sx={{ maxWidth: '12rem' }}
          >
            {FEEDBACK_STATUS_ORDER.map(status => (
              <Option key={status} value={status}>
                {FEEDBACK_STATUS_LABELS[status]}
              </Option>
            ))}
          </Select>
        </Fact>
        <Fact label="Reported" data-testid="feedback-detail-created">
          {formatDateTime(record.createdAt)}
        </Fact>
        <Fact label="Last changed" data-testid="feedback-detail-updated">
          {record.updatedAt ? formatDateTime(record.updatedAt) : undefined}
        </Fact>
      </SectionCard>
    </Stack>
  );
};

const TurnFacts = ({ turn }: { turn: NonNullable<ReturnType<typeof summarizePromptMeta>> }): ReactNode => {
  const tokens = [
    turn.inputTokens !== undefined
      ? `${formatCount(turn.inputTokens)} in${turn.cachedInputTokens ? ` (${formatCount(turn.cachedInputTokens)} cached)` : ''}`
      : undefined,
    turn.outputTokens !== undefined ? `${formatCount(turn.outputTokens)} out` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const totalTokens = formatCount(turn.totalTokens);

  return (
    <>
      <Fact label="Model" data-testid="feedback-detail-turn-model">
        {turn.model ? (turn.backend ? `${turn.model} (${turn.backend})` : turn.model) : undefined}
      </Fact>
      <Fact label="Tools" data-testid="feedback-detail-turn-tools">
        {turn.tools.length > 0 ? (
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {turn.tools.map(tool => (
              <Chip key={tool} size="sm" variant="soft" color="neutral">
                {tool}
              </Chip>
            ))}
            {turn.failedToolCallCount > 0 && <StatusChip tone="bad" label={`${turn.failedToolCallCount} failed`} />}
          </Stack>
        ) : (
          'None'
        )}
      </Fact>
      <Fact label="Tokens" data-testid="feedback-detail-turn-tokens">
        {tokens ? (totalTokens ? `${tokens} (${totalTokens} total)` : tokens) : totalTokens}
      </Fact>
      <Fact label="Knowledge search" data-testid="feedback-detail-turn-retrieval">
        {turn.retrievalOutcome}
      </Fact>
      {turn.citedSourceCount > 0 && (
        <Fact label="Sources cited" data-testid="feedback-detail-turn-sources">
          {turn.citedSourceCount}
        </Fact>
      )}
    </>
  );
};

export default FeedbackDetailDrawer;
