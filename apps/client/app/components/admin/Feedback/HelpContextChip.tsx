import { Stack, Chip, Tooltip } from '@mui/joy';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import UpdateDisabledIcon from '@mui/icons-material/UpdateDisabled';
import { IExtendedFeedbackDocument } from './types';

interface HelpContextChipProps {
  feedbackItem: Pick<IExtendedFeedbackDocument, 'helpContext'>;
}

/**
 * The article a `subject: 'help'` report came from, plus the outdated flag if the reader set one,
 * shown on the row so a triaging admin can act on the comment without leaving the console.
 *
 * `helpContext.slug` is denormalized onto the feedback record rather than read through
 * `helpContext.eventId`, and this is the surface that makes that worth doing: the HelpEvent the
 * eventId points at expires after 90 days while the feedback record persists, so the copied slug
 * is the only durable record of which article was being rated.
 *
 * Chat-surface reports carry no slug - the question and answer deliberately stay on the
 * expiring HelpEvent rather than being copied into a permanent record - so they render as the
 * surface alone.
 */
const HelpContextChip = ({ feedbackItem }: HelpContextChipProps) => {
  const { helpContext } = feedbackItem;
  if (!helpContext) return null;

  const label = helpContext.surface === 'chat' ? 'Help chat' : (helpContext.slug ?? 'Help article');
  // The slug already reads as the article, so only say "Help article:" when there is one to name.
  const tooltip =
    helpContext.surface === 'chat'
      ? 'Asked in help chat'
      : helpContext.slug
        ? `Help article: ${helpContext.slug}`
        : 'A help article that did not record its slug';

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
      <Tooltip title={tooltip}>
        <Chip
          size="sm"
          color="primary"
          variant="soft"
          startDecorator={<MenuBookIcon sx={{ fontSize: 14 }} />}
          data-testid="feedback-help-context-chip"
          sx={{ maxWidth: '100%' }}
        >
          {label}
        </Chip>
      </Tooltip>
      {helpContext.reportType === 'outdated' && (
        <Tooltip title="The reader flagged this article as out of date">
          <Chip
            size="sm"
            color="warning"
            variant="soft"
            startDecorator={<UpdateDisabledIcon sx={{ fontSize: 14 }} />}
            data-testid="feedback-help-outdated-chip"
          >
            Outdated
          </Chip>
        </Tooltip>
      )}
    </Stack>
  );
};

export default HelpContextChip;
