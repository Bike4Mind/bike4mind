import { Alert, Box, Card, Chip, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { useQuery } from '@tanstack/react-query';
import { getFeedbackByIdFromServer } from '@client/app/utils/feedbackAPICalls';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { getFeedbackDisplayContent } from './types';
import { feedbackRecordQueryKey } from './queryKeys';
import FeedbackRowLinks from './FeedbackRowLinks';

interface FocusedFeedbackCardProps {
  /** The `?feedbackId=` a deep link arrived with. */
  feedbackId: string;
  /** Clears the deep-link param, returning the reader to the unfocused list. */
  onDismiss: () => void;
}

/**
 * The record a feedback deep link points at, pinned above the list.
 *
 * Fetched by id rather than found in the rows on screen: the list is paginated and filtered
 * server-side, so a linked report is usually NOT on the current page - and may not match the
 * active filters at all. That is the whole reason this renders separately instead of just
 * highlighting a row.
 */
const FocusedFeedbackCard = ({ feedbackId, onDismiss }: FocusedFeedbackCardProps) => {
  const {
    data: feedbackItem,
    isLoading,
    isError,
  } = useQuery({
    queryKey: feedbackRecordQueryKey(feedbackId),
    queryFn: () => getFeedbackByIdFromServer(feedbackId),
  });

  return (
    <Card variant="soft" color="primary" sx={{ mb: 1 }} data-testid="feedback-focused-card">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography level="body-xs" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', mb: 0.5 }}>
            Linked report
          </Typography>

          {isLoading && <CircularProgress size="sm" data-testid="feedback-focused-loading" />}

          {/* The read route returns the same NotFoundError whether the record is gone or simply
              not the caller's, so this copy deliberately covers both rather than guessing. */}
          {(isError || (!isLoading && !feedbackItem)) && (
            <Alert color="warning" size="sm" data-testid="feedback-focused-missing">
              This report is no longer available, or you do not have access to it.
            </Alert>
          )}

          {feedbackItem && (
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Chip size="sm" variant="solid">
                  {feedbackItem.status}
                </Chip>
                {feedbackItem.organization && feedbackItem.organization !== 'Unknown' && (
                  <Chip size="sm" variant="outlined">
                    {feedbackItem.organization}
                  </Chip>
                )}
                {feedbackItem.username && <Typography level="body-sm">{feedbackItem.username}</Typography>}
                {feedbackItem.userEmail && (
                  <Tooltip title={feedbackItem.userId}>
                    <Typography level="body-sm">{feedbackItem.userEmail}</Typography>
                  </Tooltip>
                )}
                <Typography level="body-xs">{relativeTimeFormat(new Date(feedbackItem.createdAt))}</Typography>
              </Stack>
              <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                {getFeedbackDisplayContent(feedbackItem, 'No content')}
              </Typography>
            </Stack>
          )}
        </Box>

        <Stack direction="row" spacing={0.5} alignItems="center">
          {/* The card is where a Slack or email link lands, so reaching the conversation it is
              about has to be possible from here - not only from a row in the list below. */}
          {feedbackItem && <FeedbackRowLinks feedbackItem={feedbackItem} />}

          <Tooltip title="Back to all feedback">
            <IconButton size="sm" variant="plain" onClick={onDismiss} data-testid="feedback-focused-dismiss-btn">
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    </Card>
  );
};

export default FocusedFeedbackCard;
