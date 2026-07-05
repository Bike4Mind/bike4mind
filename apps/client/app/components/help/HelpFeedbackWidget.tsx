import React, { useRef, useEffect } from 'react';
import { Box, Button, Checkbox, Chip, Divider, IconButton, Textarea, Typography } from '@mui/joy';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import EditIcon from '@mui/icons-material/Edit';
import { useArticleFeedbackState } from '@client/app/hooks/useArticleFeedbackState';

interface HelpFeedbackWidgetProps {
  slug: string;
}

/**
 * Feedback widget shown at the bottom of help articles.
 *
 * Flow: click thumbs up/down -> rating is sent immediately with visual confirmation.
 * Comment box + outdated checkbox appear for optional follow-up.
 * Uses useArticleFeedbackState for shared state with the header thumbs.
 */
const HelpFeedbackWidget: React.FC<HelpFeedbackWidgetProps> = ({ slug }) => {
  const {
    rating,
    comment,
    setComment,
    reportOutdated,
    setReportOutdated,
    commentSent,
    handleRating,
    handleSubmitExtra,
    handleEditComment,
    isPending,
  } = useArticleFeedbackState(slug);

  // Scroll the comment area into view when it appears
  const commentBoxRef = useRef<HTMLDivElement>(null);
  const prevRating = useRef(rating);

  useEffect(() => {
    // Only scroll when rating transitions from null to a value (first click)
    if (rating && !prevRating.current && commentBoxRef.current) {
      commentBoxRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    prevRating.current = rating;
  }, [rating]);

  return (
    <Box sx={{ mt: 4 }}>
      <Divider sx={{ mb: 2 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Was this helpful?
        </Typography>
        <IconButton
          size="sm"
          variant={rating === 'helpful' ? 'solid' : 'outlined'}
          color={rating === 'helpful' ? 'success' : 'neutral'}
          onClick={() => handleRating('helpful')}
          data-testid="help-feedback-thumbs-up"
        >
          {rating === 'helpful' ? <ThumbUpIcon fontSize="small" /> : <ThumbUpOutlinedIcon fontSize="small" />}
        </IconButton>
        <IconButton
          size="sm"
          variant={rating === 'not_helpful' ? 'solid' : 'outlined'}
          color={rating === 'not_helpful' ? 'danger' : 'neutral'}
          onClick={() => handleRating('not_helpful')}
          data-testid="help-feedback-thumbs-down"
        >
          {rating === 'not_helpful' ? <ThumbDownIcon fontSize="small" /> : <ThumbDownOutlinedIcon fontSize="small" />}
        </IconButton>
        {rating && (
          <Chip size="sm" color="neutral" variant="soft" data-testid="help-feedback-thanks">
            Thanks for your feedback!
          </Chip>
        )}
      </Box>

      {rating && !commentSent && (
        <Box
          ref={commentBoxRef}
          sx={{
            mt: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            animation: 'feedbackFadeIn 0.2s ease-in',
            '@keyframes feedbackFadeIn': {
              from: { opacity: 0, transform: 'translateY(4px)' },
              to: { opacity: 1, transform: 'translateY(0)' },
            },
          }}
        >
          <Checkbox
            size="sm"
            label="Report outdated info"
            checked={reportOutdated}
            onChange={e => setReportOutdated(e.target.checked)}
            color="warning"
            data-testid="help-feedback-report-outdated"
          />

          <Textarea
            size="sm"
            placeholder="Additional comments (optional, max 1000 chars)"
            value={comment}
            onChange={e => setComment(e.target.value.slice(0, 1000))}
            minRows={2}
            maxRows={4}
            data-testid="help-feedback-comment"
          />
          <Button
            size="sm"
            variant="solid"
            onClick={handleSubmitExtra}
            disabled={(!comment.trim() && !reportOutdated) || isPending}
            sx={{ alignSelf: 'flex-start' }}
            data-testid="help-feedback-submit-comment"
          >
            Submit
          </Button>
        </Box>
      )}

      {rating && commentSent && (
        <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Feedback submitted
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={handleEditComment}
            data-testid="help-feedback-edit-comment"
            sx={{ '--IconButton-size': '24px' }}
          >
            <EditIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      )}
    </Box>
  );
};

export default HelpFeedbackWidget;
