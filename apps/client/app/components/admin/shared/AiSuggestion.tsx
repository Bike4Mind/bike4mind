import { useState, type ReactNode } from 'react';
import { Box, Button, Link, Stack, Tooltip, Typography } from '@mui/joy';
import { ActionDialog } from './ActionDialog';
import { ACCEPTED_AI_REASON } from './adminReason';
import { adminFocus } from './adminStyles';
import { RelativeTime } from './EntityHeader';
import { Kbd } from './Kbd';
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

// Reasons may be model-written, so only an in-app path becomes a link. URL parsing drops tabs and
// newlines anywhere, so "/<tab>/host" would resolve as the protocol-relative "//host".
const isInAppPath = (href: string): boolean => /^\/(?![/\\])[^\t\n\r]*$/.test(href);

export type AiSuggestionData = {
  id: string;
  /** What the AI proposes, as the action it would take: "Confirmed abuse". */
  proposal: string;
  probability: number | null;
  /** Row tooltip context after the proposal, e.g. which record the suggestion is about. */
  note?: string;
  reasons?: AiSuggestionReason[];
  model?: string;
  createdAt?: string;
  status?: AiSuggestionStatus;
};

const MAX_REASONS = 3;

/** Every state a suggestion can reach; nothing persists them yet (see DESIGN_GUIDE.md section 10). */
export const AI_SUGGESTION_STATUSES = [
  'pending',
  'accepted',
  'overridden',
  'dismissed',
  'auto_applied',
  'undone',
  'expired',
] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

export const AI_OVERRIDE_REASONS = ['Evidence misread', 'Missing context', 'Outdated policy', 'Other'] as const;
export type AiOverrideReason = (typeof AI_OVERRIDE_REASONS)[number];

/** The write-back an admin's decision produces for the suggestion record. */
export type AiSuggestionDecision = {
  suggestionId: string;
  status: Extract<AiSuggestionStatus, 'accepted' | 'overridden' | 'dismissed' | 'undone'>;
  overrideReason?: AiOverrideReason;
};

export type AiSuggestionProps = {
  variant: 'row' | 'detail';
  /** `null` when AI is off, over budget or failed: the slot renders nothing, never an error. */
  suggestion: AiSuggestionData | null;
  /** Opens the host's own ActionDialog, prefilled (ACCEPTED_AI_REASON); the host reports `accepted` once its write lands. */
  onAccept?: () => void;
  /** Opens the host's manual control; the host reports `overridden` once its write lands. */
  onOverride?: (reason?: AiOverrideReason) => void;
  /** Fires here for Dismiss and Undo, which complete inside the component. */
  onDecision?: (decision: AiSuggestionDecision) => void;
  /** Reverts an `auto_applied` suggestion. */
  onUndo?: () => void;
  /**
   * Detail only: open with the why-wrong picker showing, for a host reached through its Override key.
   * Read once at mount, so mount this only once the suggestion is loaded.
   */
  initialOverriding?: boolean;
  /**
   * Derived ids: `<id>-chip`, `<id>-proposal`, `<id>-confidence`, `<id>-reason-<i>`, `<id>-meta`,
   * `<id>-accept-btn`, `<id>-override-btn`, `<id>-dismiss-btn`, `<id>-why-<i>`, `<id>-override-continue-btn`,
   * `<id>-done-chip`, `<id>-undo-btn`.
   */
  'data-testid'?: string;
};

/** An AI proposal shown beside, never in place of, the admin's own control. Neutral tone: advisory, not a verdict. */
export function AiSuggestion({
  variant,
  suggestion,
  onAccept,
  onOverride,
  onDecision,
  onUndo,
  initialOverriding = false,
  'data-testid': testId = 'admin-ai-suggestion',
}: AiSuggestionProps) {
  // Keyed on the suggestion id so a new suggestion in the same slot starts fresh.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [overridingId, setOverridingId] = useState<string | null>(
    initialOverriding && onOverride && suggestion ? suggestion.id : null
  );
  const [whyWrong, setWhyWrong] = useState<AiOverrideReason | null>(null);
  if (!suggestion || dismissedId === suggestion.id) return null;
  const overriding = overridingId === suggestion.id;
  const setOverriding = (open: boolean) => {
    setOverridingId(open ? suggestion.id : null);
    setWhyWrong(null);
  };
  const word = confidenceWord(suggestion.probability);
  const label = word ? AI_CONFIDENCE_LABELS[word] : null;
  const percent = word && suggestion.probability !== null ? formatAiProbability(suggestion.probability) : null;
  const autoApplied = suggestion.status === 'auto_applied';

  if (variant === 'row') {
    const title = autoApplied
      ? `Done by AI: ${suggestion.proposal}. Open the record to undo.`
      : `AI suggestion: ${suggestion.proposal}${percent ? ` (${percent} confidence)` : ''}${suggestion.note ? ` ${suggestion.note}` : ''}. Advisory only.`;
    const keys = !autoApplied && (onAccept || onOverride);
    return (
      <Tooltip
        title={
          <span>
            {title}
            {keys && (
              <>
                {onAccept && (
                  <>
                    {' '}
                    <Kbd>A</Kbd> accept
                  </>
                )}
                {onOverride && (
                  <>
                    {' '}
                    <Kbd>O</Kbd> override
                  </>
                )}
              </>
            )}
          </span>
        }
        placement="top"
        enterTouchDelay={0}
      >
        <Box
          component="span"
          tabIndex={0}
          role="img"
          aria-label={title}
          data-testid={testId}
          onClick={event => event.stopPropagation()}
          sx={{ display: 'inline-flex', borderRadius: 'md', ...adminFocus }}
        >
          <StatusChip
            tone="neutral"
            label={
              autoApplied
                ? `${AI_ADVISORY_MARK} Done by AI`
                : `${AI_ADVISORY_MARK} ${suggestion.proposal}${label ? `, ${label}` : ''}`
            }
            data-testid={`${testId}-chip`}
          />
        </Box>
      </Tooltip>
    );
  }

  const decide = (status: AiSuggestionDecision['status']) => onDecision?.({ suggestionId: suggestion.id, status });
  const dismiss = () => {
    setDismissedId(suggestion.id);
    decide('dismissed');
  };
  const undo = () => {
    onUndo?.();
    decide('undone');
  };
  const continueOverride = () => {
    const reason = whyWrong ?? undefined;
    setOverriding(false);
    onOverride?.(reason);
  };

  const reasons = (suggestion.reasons ?? []).slice(0, MAX_REASONS);
  return (
    <Stack
      gap={1}
      data-testid={testId}
      sx={{ p: 1.5, borderRadius: 'md', border: '1px solid', borderColor: 'admin.border', bgcolor: 'admin.surface' }}
    >
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          <span aria-hidden>{AI_ADVISORY_MARK}</span> {autoApplied ? 'AI applied' : 'AI suggests'}
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
        {autoApplied && <StatusChip tone="neutral" label="Done by AI" data-testid={`${testId}-done-chip`} />}
      </Stack>
      {reasons.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid={`${testId}-reasons`}>
          {reasons.map((reason, index) => (
            <Typography key={index} component="li" level="body-sm" data-testid={`${testId}-reason-${index}`}>
              {reason.evidenceHref && isInAppPath(reason.evidenceHref) ? (
                <Link href={reason.evidenceHref}>{reason.text}</Link>
              ) : (
                reason.text
              )}
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
      {overriding ? (
        <Stack gap={1} role="group" aria-label="Why was the AI wrong?">
          <Typography level="body-sm">Why was the AI wrong? (optional)</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.75}>
            {AI_OVERRIDE_REASONS.map((reason, index) => (
              <Button
                key={reason}
                size="sm"
                variant={whyWrong === reason ? 'soft' : 'outlined'}
                color="neutral"
                aria-pressed={whyWrong === reason}
                onClick={() => setWhyWrong(current => (current === reason ? null : reason))}
                data-testid={`${testId}-why-${index}`}
              >
                {reason}
              </Button>
            ))}
          </Stack>
          <Stack direction="row" gap={1}>
            <Button size="sm" onClick={continueOverride} data-testid={`${testId}-override-continue-btn`}>
              Continue
            </Button>
            <Button size="sm" variant="plain" color="neutral" onClick={() => setOverriding(false)}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : autoApplied ? (
        onUndo && (
          <Stack direction="row" gap={1}>
            <Button size="sm" variant="outlined" color="neutral" onClick={undo} data-testid={`${testId}-undo-btn`}>
              Undo
            </Button>
          </Stack>
        )
      ) : (
        (onAccept || onOverride || onDecision) && (
          <Stack direction="row" gap={1}>
            {onAccept && (
              <Button size="sm" variant="outlined" onClick={onAccept} data-testid={`${testId}-accept-btn`}>
                Accept
              </Button>
            )}
            {onOverride && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setOverriding(true)}
                data-testid={`${testId}-override-btn`}
              >
                Override
              </Button>
            )}
            {onDecision && (
              <Button size="sm" variant="plain" color="neutral" onClick={dismiss} data-testid={`${testId}-dismiss-btn`}>
                Dismiss
              </Button>
            )}
          </Stack>
        )
      )}
    </Stack>
  );
}

const isOpenHigh = (suggestion: AiSuggestionData | null): boolean =>
  !!suggestion &&
  (suggestion.status === undefined || suggestion.status === 'pending') &&
  confidenceWord(suggestion.probability) === 'high';

export type AiSuggestionBulkAcceptProps<T> = {
  items: readonly T[];
  getSuggestion: (item: T) => AiSuggestionData | null;
  /** Only a command the admin can undo may be bulk-accepted; an irreversible one is a type error here. */
  reversible: true;
  /** The before -> after of applying every High suggestion, normally a ChangePreview. */
  renderPreview: (high: readonly T[]) => ReactNode;
  /** Receives the High items and the composed audit reason; rejecting keeps the dialog open. */
  onApply: (high: readonly T[], reason: string) => void | Promise<void>;
  'data-testid'?: string;
};

/** "Accept all High (n)": applies only pending High-confidence suggestions, through an ActionDialog with a preview. */
export function AiSuggestionBulkAccept<T>({
  items,
  getSuggestion,
  renderPreview,
  onApply,
  'data-testid': testId = 'admin-ai-bulk-accept',
}: AiSuggestionBulkAcceptProps<T>) {
  const [open, setOpen] = useState(false);
  const high = items.filter(item => isOpenHigh(getSuggestion(item)));
  return (
    <>
      <Button
        size="sm"
        variant="outlined"
        disabled={high.length === 0}
        onClick={() => setOpen(true)}
        data-testid={`${testId}-btn`}
      >
        {`Accept all High (${high.length})`}
      </Button>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Accept all High suggestions"
        description={`${AI_ADVISORY_MARK} Applies the AI suggestion on ${high.length} record${high.length === 1 ? '' : 's'}.`}
        reasonPresets={[]}
        initialReason={ACCEPTED_AI_REASON}
        confirmLabel={`Accept ${high.length}`}
        onConfirm={async reason => {
          await onApply(high, reason);
          setOpen(false);
        }}
        data-testid={`${testId}-dialog`}
      >
        {renderPreview(high)}
      </ActionDialog>
    </>
  );
}
