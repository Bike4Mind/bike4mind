import React from 'react';
import { Tooltip } from '@mui/joy';
import type { AbuseAssessmentJudgment } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { SignupRiskReviewRow } from '@client/app/hooks/data/signupRiskReviews';
import { AiSuggestion, StatusChip, relativeTime } from './shared';
import { DETECTOR_LABELS } from './shadowDetectorLabels';

export type SignupAdvisory = NonNullable<SignupRiskReviewRow['advisory']>;

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

// Only an abuse verdict is colored: a model's "legitimate" must not read as a reason to approve.
const ADVISORY_DISPLAY: Record<AbuseAssessmentJudgment, { label: string; tone: AdminStatusTone }> = {
  abuse: { label: 'Model: abuse', tone: 'bad' },
  legitimate_automation: { label: 'Model: legit automation', tone: 'neutral' },
  insufficient_evidence: { label: 'Model: unsure', tone: 'neutral' },
};

export function advisoryTooltip(advisory: SignupAdvisory, now: number): string {
  const confidence = advisory.confidence === null ? '' : `, ${Math.round(advisory.confidence * 100)}% confident`;
  const otherCount = plural(advisory.otherVerdicts, 'other verdict');
  let others = '';
  if (advisory.result === 'abuse' && advisory.newerVerdicts > 0) {
    others = ` This abuse verdict is shown over ${plural(advisory.newerVerdicts, 'newer verdict')}; ${otherCount} on this account.`;
  } else if (advisory.otherVerdicts > 0) {
    others = ` ${otherCount} on this account.`;
  }
  return `Advisory model verdict on a detection (${DETECTOR_LABELS[advisory.detector]})${confidence}, ${relativeTime(
    new Date(advisory.assessedAt),
    now
  )}.${others} It never approves or blocks an account.`;
}

type Props = {
  /** The account the advisory is about; test ids are `<testIdPrefix>-advisory-<userId>` / `-ai-<userId>`. */
  userId: string;
  advisory: SignupAdvisory | null;
  now: number;
  testIdPrefix: string;
  /** What the model proposes for an abuse verdict, e.g. "Likely abuse: keep in review". */
  abuseProposal: string;
  onAccept?: () => void;
  onOverride?: () => void;
};

/** An abuse verdict this queue has not yet decided: the only state that offers accept or override. */
export const isAssessmentOpen = (advisory: SignupAdvisory | null | undefined): advisory is SignupAdvisory =>
  advisory?.result === 'abuse' && !advisory.decision;

/**
 * The model's advisory verdict on a user queue row. An abuse verdict is an AI suggestion the admin
 * can accept or override; a decided one shows its outcome; any other verdict stays a neutral chip with no accept, so a model's
 * "legitimate" never reads as a reason to approve.
 */
export const SignupAdvisoryCell: React.FC<Props> = ({
  userId,
  advisory,
  now,
  testIdPrefix,
  abuseProposal,
  onAccept,
  onOverride,
}) => {
  if (!advisory) return null;
  if (advisory.result === 'abuse' && !advisory.decision) {
    return (
      <AiSuggestion
        variant="row"
        suggestion={{
          id: advisory.assessmentId,
          proposal: abuseProposal,
          probability: advisory.confidence,
          note: advisoryTooltip(advisory, now).replace(/\.$/, ''),
        }}
        onAccept={onAccept}
        onOverride={onOverride}
        data-testid={`${testIdPrefix}-ai-${userId}`}
      />
    );
  }
  const display = ADVISORY_DISPLAY[advisory.result];
  return (
    <Tooltip title={advisoryTooltip(advisory, now)}>
      <span tabIndex={0} data-testid={`${testIdPrefix}-advisory-${userId}`}>
        <StatusChip tone={display.tone} label={display.label} />
        {advisory.decision && (
          <StatusChip
            tone="neutral"
            label={advisory.decision === 'accepted' ? 'Accepted' : 'Overridden'}
            data-testid={`${testIdPrefix}-decision-${userId}`}
          />
        )}
      </span>
    </Tooltip>
  );
};
