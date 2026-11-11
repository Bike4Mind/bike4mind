import type { AiAbuseAdvisoryRow } from '@client/app/hooks/data/aiAdvisory';
import { AiSuggestion } from '../../shared/AiSuggestion';
import { DETECTOR_LABELS } from '../../shadowDetectorLabels';

/** The Users list's mark for an account the AI advisory flags; see listAiAbuseAdvisories. Display only. */
export function AiAdvisoryBadge({ advisory }: { advisory: AiAbuseAdvisoryRow }) {
  return (
    <AiSuggestion
      variant="row"
      suggestion={{
        id: advisory.detectionId,
        proposal: 'Confirmed abuse',
        probability: advisory.abuseProbability,
        note: `on an unreviewed ${DETECTOR_LABELS[advisory.detector]} detection`,
        createdAt: advisory.assessedAt,
      }}
      data-testid={`admin-users-ai-advisory-${advisory.userId}`}
    />
  );
}
