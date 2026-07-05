import { FC, useState } from 'react';
import { Box, Button, Card, Chip, Stack, Typography } from '@mui/joy';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import type { Episode } from '@bike4mind/agents';

interface EpisodeCardProps {
  episode: Episode;
  /** Request an adversarial review of this episode (omitted = no button). */
  onRequestReview?: (episodeId: string) => void;
  /** True while a review of THIS episode is running. */
  reviewPending?: boolean;
}

/** Verdict color for an adversarial_review episode, parsed from its verdict observation. */
function verdictColor(episode: Episode): 'success' | 'warning' | 'danger' | 'neutral' {
  const verdict = episode.observations.find(o => o.kind === 'review_verdict')?.summary ?? '';
  if (verdict.startsWith('approved')) return 'success';
  if (verdict.startsWith('needs-changes')) return 'warning';
  if (verdict.startsWith('rejected')) return 'danger';
  return 'neutral';
}

/**
 * One wake cycle, rendered: when, what the policy chose, which tools ran,
 * what the agent learned, and - load-bearing for review - what it explicitly
 * did NOT do (scope locks). Reviewer episodes get a verdict-colored gavel;
 * reviewed episodes carry the audit badge.
 */
const EpisodeCard: FC<EpisodeCardProps> = ({ episode, onRequestReview, reviewPending }) => {
  const [showLocks, setShowLocks] = useState(false);
  const [showReflection, setShowReflection] = useState(false);
  const tools = episode.actionsTaken.map(a => a.tool);
  const finalAnswer = episode.observations.find(o => o.kind === 'final_answer')?.summary;
  const isReviewEpisode = episode.policyDecision.actionKind === 'adversarial_review';
  const reviewVerdict = isReviewEpisode
    ? episode.observations.find(o => o.kind === 'review_verdict')?.summary
    : undefined;

  return (
    <Card
      variant="outlined"
      size="sm"
      color={isReviewEpisode ? verdictColor(episode) : 'neutral'}
      data-testid="deep-agent-episode-card"
    >
      <Stack spacing={1}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {new Date(episode.wakeAt).toLocaleString()}
          </Typography>
          <Chip
            size="sm"
            color={isReviewEpisode ? verdictColor(episode) : 'primary'}
            variant="soft"
            startDecorator={isReviewEpisode ? <GavelOutlinedIcon /> : undefined}
          >
            {episode.policyDecision.actionKind}
          </Chip>
          <Chip size="sm" variant="outlined">
            {episode.evidenceTier}
          </Chip>
          {episode.reviewedByEpisodeId && (
            <Chip size="sm" variant="soft" color="success" data-testid="episode-reviewed-badge">
              reviewed ✓
            </Chip>
          )}
          {episode.tokensSpent > 0 && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {episode.tokensSpent.toLocaleString()} tok
            </Typography>
          )}
          {!isReviewEpisode && !episode.reviewedByEpisodeId && onRequestReview && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<GavelOutlinedIcon />}
              loading={reviewPending}
              onClick={() => onRequestReview(episode.id)}
              sx={{ ml: 'auto' }}
              data-testid="episode-request-review-btn"
            >
              Request review
            </Button>
          )}
        </Box>

        {reviewVerdict && (
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }} data-testid="episode-review-verdict">
            ⚖️ {reviewVerdict}
          </Typography>
        )}

        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          {episode.policyDecision.rationale}
        </Typography>

        {tools.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {tools.map((tool, i) => (
              <Chip key={`${tool}-${i}`} size="sm" color="success" variant="soft">
                {tool}
              </Chip>
            ))}
          </Box>
        )}

        {finalAnswer && (
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
            {finalAnswer}
          </Typography>
        )}

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            size="sm"
            variant="plain"
            onClick={() => setShowReflection(v => !v)}
            data-testid="episode-reflection-toggle"
          >
            {showReflection ? 'Hide' : 'Show'} reflection
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setShowLocks(v => !v)}
            data-testid="episode-scopelocks-toggle"
          >
            Scope locks ({episode.scopeLocks.length})
          </Button>
        </Box>

        {showReflection && (
          <Typography level="body-sm" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
            {episode.reflection}
          </Typography>
        )}

        {showLocks && (
          <Stack spacing={0.25}>
            {episode.scopeLocks.length === 0 && (
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                (none recorded)
              </Typography>
            )}
            {episode.scopeLocks.map((lock, i) => (
              <Typography key={i} level="body-xs" sx={{ color: 'text.tertiary' }}>
                🔒 {lock}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
};

export default EpisodeCard;
