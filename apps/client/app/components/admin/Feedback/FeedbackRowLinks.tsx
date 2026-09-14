import { IconButton, Stack, Tooltip } from '@mui/joy';
import LinkIcon from '@mui/icons-material/Link';
import ForumIcon from '@mui/icons-material/Forum';
import { adminFeedbackRecordPath, sessionPath, sessionTurnPath, toAbsoluteUrl } from '@bike4mind/common';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import { IExtendedFeedbackDocument } from './types';

interface FeedbackRowLinksProps {
  feedbackItem: Pick<IExtendedFeedbackDocument, '_id' | 'sessionId' | 'questId'>;
}

/**
 * The two deep links a triaging admin needs on a feedback row: a shareable link back to this
 * record, and a jump to the conversation turn the report is about.
 *
 * Both are built from the shared path builders in common/utils/deepLinks rather than composed
 * here, because the same scheme is emitted server-side into Slack and email notifications - one
 * definition keeps a link pasted into Slack and a link copied from this row identical.
 *
 * The conversation link is an anchor opening a new tab rather than a router navigate: the admin is
 * mid-triage with filters and a page cursor on screen, and routing away discards all of it. It
 * also makes the link middle-clickable, which is how anyone reading a list of reports uses it.
 */
const FeedbackRowLinks = ({ feedbackItem }: FeedbackRowLinksProps) => {
  const { _id, sessionId, questId } = feedbackItem;

  const copyRecordLink = () =>
    copyTextWithToast(
      toAbsoluteUrl(window.location.origin, adminFeedbackRecordPath(_id)),
      'Link to this report copied'
    );

  // A product-level report has no session and a session-level one has no turn, so the target
  // degrades from turn to session to absent rather than building a link to neither.
  const conversationPath = sessionId ? (questId ? sessionTurnPath(sessionId, questId) : sessionPath(sessionId)) : null;

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Tooltip title="Copy link to this report">
        <IconButton size="sm" variant="plain" onClick={copyRecordLink} data-testid="feedback-copy-link-btn">
          <LinkIcon />
        </IconButton>
      </Tooltip>

      {conversationPath && (
        <Tooltip title={questId ? 'Open the conversation at this turn' : 'Open the conversation'}>
          <IconButton
            size="sm"
            variant="plain"
            component="a"
            href={conversationPath}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="feedback-open-conversation-btn"
          >
            <ForumIcon />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
};

export default FeedbackRowLinks;
