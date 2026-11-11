import { Box, Link, Stack, Tooltip, Typography } from '@mui/joy';
import { adminFocus } from './adminStyles';
import { RelativeTime } from './EntityHeader';
import { StatusChip } from './StatusChip';

/** Marks every AI-originated value in the admin UI (DESIGN_GUIDE.md section 10). */
export const AI_ADVISORY_MARK = '\u2726';

export type AiConfidence = 'high' | 'medium' | 'low';

export const AI_CONFIDENCE_LABELS: Record<AiConfidence, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** Admins read a word, not a number: >= 0.8 high, >= 0.5 medium, else low; anything outside [0, 1] has none. */
export function confidenceWord(probability: number | null | undefined): AiConfidence | null {
  if (probability === null || probability === undefined || !Number.isFinite(probability)) return null;
  if (probability < 0 || probability > 1) return null;
  if (probability >= 0.8) return 'high';
  if (probability >= 0.5) return 'medium';
  return 'low';
}

export const formatAiProbability = (probability: number): string => `${Math.round(probability * 100)}%`;

export type AiSuggestionReason = { text: string; evidenceHref?: string };

export type AiSuggestionData = {
  id: string;
  /** What the AI proposes, as the action it would take: "Confirmed abuse". */
  proposal: string;
  probability: number | null;
  reasons?: AiSuggestionReason[];
  model?: string;
  createdAt?: string;
};

const MAX_REASONS = 3;

export type AiSuggestionProps = {
  variant: 'row' | 'detail';
  /** `null` when AI is off, over budget or failed: the slot renders nothing, never an error. */
  suggestion: AiSuggestionData | null;
  /** Derived ids: `<id>-chip`, `<id>-proposal`, `<id>-confidence`, `<id>-reason-<i>`, `<id>-meta`. */
  'data-testid'?: string;
};

/** An AI proposal shown beside, never in place of, the admin's own control. Neutral tone: advisory, not a verdict. */
export function AiSuggestion({
  variant,
  suggestion,
  'data-testid': testId = 'admin-ai-suggestion',
}: AiSuggestionProps) {
  if (!suggestion) return null;
  const word = confidenceWord(suggestion.probability);
  const label = word ? AI_CONFIDENCE_LABELS[word] : null;
  const percent = word && suggestion.probability !== null ? formatAiProbability(suggestion.probability) : null;

  if (variant === 'row') {
    const title = `AI suggestion: ${suggestion.proposal}${percent ? ` (${percent} confidence)` : ''}. Advisory only.`;
    return (
      <Tooltip title={title} placement="top" enterTouchDelay={0}>
        <Box
          component="span"
          tabIndex={0}
          aria-label={title}
          data-testid={testId}
          onClick={event => event.stopPropagation()}
          sx={{ display: 'inline-flex', borderRadius: 'md', ...adminFocus }}
        >
          <StatusChip
            tone="neutral"
            label={`${AI_ADVISORY_MARK} ${suggestion.proposal}${label ? `, ${label}` : ''}`}
            data-testid={`${testId}-chip`}
          />
        </Box>
      </Tooltip>
    );
  }

  const reasons = (suggestion.reasons ?? []).slice(0, MAX_REASONS);
  return (
    <Stack
      gap={1}
      data-testid={testId}
      sx={{ p: 1.5, borderRadius: 'md', border: '1px solid', borderColor: 'admin.border', bgcolor: 'admin.surface' }}
    >
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          <span aria-hidden>{AI_ADVISORY_MARK}</span> AI suggests
        </Typography>
        <Typography level="title-sm" data-testid={`${testId}-proposal`}>
          {suggestion.proposal}
        </Typography>
        {label && (
          <Tooltip title={`${percent} confidence`} placement="top" enterTouchDelay={0}>
            <Typography
              level="body-sm"
              tabIndex={0}
              data-confidence={word}
              data-testid={`${testId}-confidence`}
              sx={{ color: 'admin.inkMuted', borderRadius: 'sm', ...adminFocus }}
            >
              {label} confidence
            </Typography>
          </Tooltip>
        )}
      </Stack>
      {reasons.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid={`${testId}-reasons`}>
          {reasons.map((reason, index) => (
            <Typography key={index} component="li" level="body-sm" data-testid={`${testId}-reason-${index}`}>
              {reason.evidenceHref ? <Link href={reason.evidenceHref}>{reason.text}</Link> : reason.text}
            </Typography>
          ))}
        </Box>
      )}
      {(suggestion.model || suggestion.createdAt) && (
        <Stack direction="row" alignItems="center" gap={1} data-testid={`${testId}-meta`}>
          {suggestion.model && (
            <Typography level="body-xs" fontFamily="code" sx={{ color: 'admin.inkMuted' }}>
              {suggestion.model}
            </Typography>
          )}
          <RelativeTime at={suggestion.createdAt} />
        </Stack>
      )}
    </Stack>
  );
}
