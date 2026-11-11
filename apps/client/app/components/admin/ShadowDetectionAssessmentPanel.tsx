import React, { useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import {
  hasAdminPermission,
  assessmentCompletionSequenceSchema,
  assessmentCompletionSynchronySchema,
  type AbuseAssessmentFailureCode,
  type AbuseAssessmentResult,
  type AbuseAssessmentSkipReason,
  type ShadowDetectionVerdict,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useAbuseAssessments,
  useRequestAbuseAssessment,
  type AbuseAssessmentRow,
} from '@client/app/hooks/data/shadowDetections';
import { getErrorMessage } from '@client/app/utils/error';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { AiSuggestion, StatusChip, formatUtc, type AiOverrideReason, type AiSuggestionData } from './shared';

const muted = { color: 'admin.inkMuted' } as const;

const RESULT_DISPLAY: Record<AbuseAssessmentResult, { label: string; tone: AdminStatusTone }> = {
  abuse: { label: 'Abuse', tone: 'bad' },
  legitimate_automation: { label: 'Legitimate automation', tone: 'good' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const FAILURE_MESSAGES: Record<AbuseAssessmentFailureCode, string> = {
  provider_not_configured: 'The model provider is not configured.',
  model_unavailable: 'The model was not available.',
  provider_overloaded: 'The model provider was overloaded.',
  provider_rejected: 'The model provider rejected the request.',
  provider_error: 'The model provider returned an error.',
  malformed_response: 'The model returned an answer that could not be read.',
  refused: 'The model declined to answer.',
  invalid_request: 'The request to the model was invalid.',
};

const SKIP_MESSAGES: Record<AbuseAssessmentSkipReason, string> = {
  disabled: 'Advisory assessment is off in admin settings.',
  no_model: 'No assessment model is configured.',
  model_not_callable: 'The configured model cannot be called right now.',
  budget_exhausted: 'The assessment budget is used up.',
  call_cap_reached: 'The assessment call limit was reached.',
  busy: 'Too many assessments are running. Try again shortly.',
  in_flight: 'An assessment of this detection is already running.',
  attempts_exhausted: 'This evidence has failed too many times to be retried.',
  detection_not_found: 'This detection no longer exists.',
  self_assessed: 'This detection carries its own advisory verdict.',
  time_budget: 'The assessment ran out of time. Try again.',
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const formatDate = (iso: string): string => formatUtc(new Date(iso));

const ResultChip: React.FC<{ item: AbuseAssessmentRow; testId?: string }> = ({ item, testId }) => (
  <StatusChip tone={RESULT_DISPLAY[item.result].tone} label={RESULT_DISPLAY[item.result].label} data-testid={testId} />
);

const SequenceEvidence: React.FC<{ summary: Record<string, unknown> }> = ({ summary }) => {
  const parsed = assessmentCompletionSequenceSchema.safeParse(summary.completionSequence);
  if (!parsed.success) return null;
  const evidence = parsed.data;
  return (
    <Alert color="neutral" data-testid="assessment-completion-sequence">
      <Stack gap={0.5}>
        <Typography level="title-sm">Coordinated API activity - review only</Typography>
        <Typography level="body-sm">
          {evidence.status === 'observed'
            ? `${evidence.memberRefs.length} summarized accounts repeated the same settlement order across ${evidence.rounds} rounds, with ${evidence.minRequestsPerRound}-${evidence.maxRequestsPerRound} recorded requests per round.`
            : 'Sequence evidence is incomplete: some participants or source evidence could not be included.'}
        </Typography>
        <Typography level="body-sm">
          This is coordination evidence, not proof of abuse or the same operator. Legitimate schedulers and team
          automation can look the same. These detections cannot trigger automated containment.
        </Typography>
        <Typography level="body-xs">
          Only retained successful API-completion settlements are covered; settlement order is not request start order.
        </Typography>
        {evidence.status === 'observed' && evidence.scanTruncated && (
          <Typography level="body-sm">The source scan reached a cap; this observation is incomplete.</Typography>
        )}
      </Stack>
    </Alert>
  );
};

const SynchronyEvidence: React.FC<{ summary: Record<string, unknown> }> = ({ summary }) => {
  const parsed = assessmentCompletionSynchronySchema.safeParse(summary.completionSynchrony);
  if (!parsed.success) return null;
  const value = parsed.data;
  return (
    <Alert color="neutral" data-testid="assessment-completion-synchrony">
      <Stack gap={0.5}>
        <Typography level="title-sm">Synchronized API calls - review only</Typography>
        <Typography level="body-sm">
          {value.status === 'observed'
            ? `${value.memberRefs.length} accounts shared ${value.bursts} request-start bursts and ${value.synchronizedModelSwitches} requested-model switches. ${value.dailyCapRejectedRequests} matched requests were stopped by daily free-tier caps.`
            : 'Participants or request-start evidence could not be fully included.'}
        </Typography>
        <Typography level="body-sm">
          Timing and model choices support coordination, not proof of one operator, the same prompts or misuse. These
          observations cannot trigger automated containment.
        </Typography>
        {value.status === 'observed' && (value.scanTruncated || value.legacyRows > 0) && (
          <Typography level="body-xs">
            Coverage is incomplete because the scan was capped or older rows lack request-start metadata.
          </Typography>
        )}
      </Stack>
    </Alert>
  );
};

// The verdict an admin would record to agree with the model; `unknown` proposes nothing.
const RESULT_VERDICT: Partial<Record<AbuseAssessmentResult, { verdict: ShadowDetectionVerdict; label: string }>> = {
  abuse: { verdict: 'confirmed_abuse', label: 'Confirmed abuse' },
  legitimate_automation: { verdict: 'legitimate_automation', label: 'Legitimate automation' },
  insufficient_evidence: { verdict: 'insufficient_evidence', label: 'Insufficient evidence' },
};

/** The assessment as an AI suggestion, or null when it proposes no verdict. */
export const assessmentToSuggestion = (
  item: AbuseAssessmentRow
): { verdict: ShadowDetectionVerdict; suggestion: AiSuggestionData } | null => {
  const proposal = RESULT_VERDICT[item.result];
  if (!proposal) return null;
  return {
    verdict: proposal.verdict,
    // Assessments carry no reasons; the probabilities and evidence below stand in for them. The word reads
    // the proposed result's own probability, as the row chip does, not `confidence` (a spread measure).
    // No createdAt: the model line below already dates the assessment.
    suggestion: {
      id: item.id,
      proposal: proposal.label,
      probability: item.probabilities.find(entry => entry.value === item.result)?.probability ?? null,
    },
  };
};

type DecisionProps = {
  /** Fills the host's verdict control with the proposed verdict; the host records it. */
  onAccept?: (verdict: ShadowDetectionVerdict) => void;
  /** Leaves the verdict to the admin, with the optional why-wrong pick. */
  onOverride?: (reason?: AiOverrideReason) => void;
  /** Opens the suggestion with its why-wrong picker showing. */
  initialOverriding?: boolean;
};

const LatestAssessment: React.FC<{ item: AbuseAssessmentRow } & DecisionProps> = ({
  item,
  onAccept,
  onOverride,
  initialOverriding,
}) => {
  const proposed = assessmentToSuggestion(item);
  return (
    <Stack gap={0.75} data-testid="shadow-detection-assessment-latest">
      {proposed ? (
        <AiSuggestion
          variant="detail"
          suggestion={proposed.suggestion}
          onAccept={onAccept && (() => onAccept(proposed.verdict))}
          onOverride={onOverride}
          initialOverriding={initialOverriding}
          data-testid="shadow-detection-assessment-suggestion"
        />
      ) : (
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <ResultChip item={item} testId="shadow-detection-assessment-result" />
          {item.confidence !== null && (
            <Typography level="body-sm" data-testid="shadow-detection-assessment-confidence">
              Confidence {percent(item.confidence)}
            </Typography>
          )}
        </Stack>
      )}
      {item.result === 'unknown' && (
        <Typography level="body-sm" data-testid="shadow-detection-assessment-failure">
          {item.failure ? FAILURE_MESSAGES[item.failure] : 'No usable answer came back.'}
        </Typography>
      )}
      {item.probabilities.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="shadow-detection-assessment-probabilities">
          {item.probabilities.map(entry => (
            <Typography key={entry.value} component="li" level="body-sm">
              {RESULT_DISPLAY[entry.value].label}: {percent(entry.probability)}
            </Typography>
          ))}
        </Box>
      )}
      <SequenceEvidence summary={item.featureSummary} />
      <SynchronyEvidence summary={item.featureSummary} />
      <Typography level="body-xs" sx={muted}>
        {item.model}
        {item.modelVersion ? ` (${item.modelVersion})` : ''} / policy v{item.policyVersion} / evidence v
        {item.evidenceVersion} / {item.trigger === 'sweep' ? 'automatic sweep' : 'requested by an admin'} /{' '}
        {formatDate(item.assessedAt)}
      </Typography>
      <Box component="details" data-testid="shadow-detection-assessment-evidence">
        <Box component="summary" sx={{ cursor: 'pointer', typography: 'body-sm' }}>
          What the model saw
        </Box>
        <Box
          component="pre"
          sx={{ m: 0, mt: 0.5, p: 1, fontSize: 'xs', overflow: 'auto', maxHeight: '20rem', bgcolor: 'admin.canvas' }}
        >
          {JSON.stringify(item.featureSummary, null, 2)}
        </Box>
      </Box>
    </Stack>
  );
};

const EarlierAssessments: React.FC<{ items: AbuseAssessmentRow[] }> = ({ items }) => (
  <Stack gap={0.25} data-testid="shadow-detection-assessment-earlier">
    <Typography level="body-xs" sx={muted}>
      Earlier assessments
    </Typography>
    {items.map(item => (
      <Stack key={item.id} direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <ResultChip item={item} />
        <Typography level="body-xs" sx={muted}>
          {item.confidence !== null ? `${percent(item.confidence)} / ` : ''}evidence v{item.evidenceVersion} /{' '}
          {formatDate(item.assessedAt)}
        </Typography>
      </Stack>
    ))}
  </Stack>
);

type Props = { detectionId: string; enabled: boolean } & DecisionProps;

/** An advisory model assessment of one detection, shown beside the facts it was made from. */
export const ShadowDetectionAssessmentPanel: React.FC<Props> = ({
  detectionId,
  enabled,
  onAccept,
  onOverride,
  initialOverriding,
}) => {
  const assessments = useAbuseAssessments(detectionId, { enabled });
  const request = useRequestAbuseAssessment();
  const { currentUser } = useUser();
  // Asking spends platform budget, so it needs the moderation permission the POST route enforces.
  const canAssess = hasAdminPermission(currentUser, 'users:moderate');
  const [outcome, setOutcome] = useState<string | null>(null);

  const assess = async () => {
    setOutcome(null);
    let result;
    try {
      result = await request.mutateAsync(detectionId);
    } catch {
      return; // request.error renders the failure.
    }
    if (result.status === 'skipped') setOutcome(SKIP_MESSAGES[result.reason]);
    else if (result.cached) setOutcome('The evidence is unchanged, so the existing assessment was reused.');
  };

  const items = assessments.data ?? [];
  const [latest, ...earlier] = items;

  return (
    <Stack gap={1} data-testid="shadow-detection-assessment-panel">
      <Typography level="body-xs" sx={muted}>
        Advisory assessment
      </Typography>
      <Typography level="body-xs" sx={muted}>
        Generated by a model, not calibrated, and never acts on accounts. Compare it with the facts above.
      </Typography>
      {assessments.isPending && enabled ? (
        <Typography level="body-sm" sx={muted}>
          Loading...
        </Typography>
      ) : assessments.error ? (
        <Alert color="danger" data-testid="shadow-detection-assessment-load-error">
          {getErrorMessage(assessments.error)}
        </Alert>
      ) : latest ? (
        <LatestAssessment
          item={latest}
          onAccept={onAccept}
          onOverride={onOverride}
          initialOverriding={initialOverriding}
        />
      ) : (
        <Typography level="body-sm" sx={muted} data-testid="shadow-detection-assessment-empty">
          Not assessed yet.
        </Typography>
      )}
      {earlier.length > 0 && <EarlierAssessments items={earlier} />}
      {outcome && (
        <Alert color="neutral" data-testid="shadow-detection-assessment-outcome">
          {outcome}
        </Alert>
      )}
      {request.error && (
        <Alert color="danger" data-testid="shadow-detection-assessment-error">
          {getErrorMessage(request.error)}
        </Alert>
      )}
      {canAssess && (
        <Box>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={request.isPending}
            disabled={request.isPending}
            onClick={() => void assess()}
            data-testid="shadow-detection-assess-btn"
          >
            Assess now
          </Button>
        </Box>
      )}
    </Stack>
  );
};
