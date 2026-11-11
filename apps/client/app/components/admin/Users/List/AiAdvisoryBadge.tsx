import type { AiAbuseAdvisoryRow } from '@client/app/hooks/data/aiAdvisory';
import { AiSuggestion } from '../../shared/AiSuggestion';

/** The Users list's mark for an account the AI advisory flags; see listAiAbuseAdvisories. Display only. */
export function AiAdvisoryBadge({ advisory }: { advisory: AiAbuseAdvisoryRow }) {
  return (
    <AiSuggestion
      variant="row"
      suggestion={{
        id: advisory.detectionId,
        proposal: 'Likely abuse',
        probability: advisory.abuseProbability,
        createdAt: advisory.assessedAt,
      }}
      data-testid={`admin-users-ai-advisory-${advisory.userId}`}
    />
  );
}
