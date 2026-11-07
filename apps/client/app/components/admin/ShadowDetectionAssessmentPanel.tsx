import React, { useState } from 'react';
import { AbuseAssessmentReasons } from './AbuseAssessmentReasons';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import {
  abuseAssessmentAccountProfileSchema,
  hasAdminPermission,
  type AbuseAssessmentAccountProfile,
  type AbuseAssessmentFailureCode,
  type AbuseAssessmentResult,
  type AbuseAssessmentSkipReason,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useAbuseAssessments,
  useRequestAbuseAssessment,
  type AbuseAssessmentRow,
} from '@client/app/hooks/data/shadowDetections';
import { getErrorMessage } from '@client/app/utils/error';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { StatusChip, formatUtc } from './shared';

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

const yesNo = (value: boolean | null): string => (value === null ? 'unknown' : value ? 'yes' : 'no');
const count = (value: number): string => value.toLocaleString('en-US');

/** One line per fact of a v2 account profile, in the words the admin user page uses. */
export function describeAccountProfile(profile: AbuseAssessmentAccountProfile): string[] {
  const { signupNetwork: network, email, spend, linkedAccounts: linked } = profile;
  const lines = [
    `Signup: ${profile.signupMethod === 'otc' ? 'email code' : profile.signupMethod}; hosting/VPN network ` +
      `${yesNo(network.hosting)}, anonymous IP ${yesNo(network.anonymousIp)}, JA4 ${network.ja4Present ? 'present' : 'absent'}`,
  ];
  if (email) {
    const traits = [
      email.plusAddressed && (email.randomLookingPlusTag ? 'plus-addressed, random-looking tag' : 'plus-addressed'),
      email.generatedLocalPart && 'generated-looking name',
      email.consumerMailDomain ? 'webmail domain' : 'own domain',
    ].filter((trait): trait is string => typeof trait === 'string');
    lines.push(`Email: ${traits.join(', ')}`);
  }
  if (profile.minutesToTwoFactor !== null)
    lines.push(`Two-factor: ${count(profile.minutesToTwoFactor)} min after signup`);
  if (profile.minutesToFirstSpend !== null)
    lines.push(`First spend: ${count(profile.minutesToFirstSpend)} min after signup`);
  if (spend) {
    const models = spend.byModel
      .map(entry => `${entry.model ?? 'no model'} ${percent(entry.creditShare)} (${count(entry.creditsPerEvent)}/call)`)
      .join(', ');
    lines.push(`Spend: ${count(spend.totalCredits)} credits${models ? ` - ${models}` : ''}`);
  }
  if (linked) {
    lines.push(
      `Linked within ${linked.windowHours}h: ${count(linked.total)}${linked.truncated ? '+' : ''} ` +
        `(${count(linked.blocked)} blocked; signup IP ${linked.sharedSignupIp}, JA4 ${linked.sharedJa4}, ` +
        `mailbox ${linked.sharedMailbox}, mail domain ${linked.sharedMailDomain})`
    );
  }
  return lines;
}

/** Stored summaries are returned as recorded, so v1 rows (no profile) simply render nothing here. */
function profilesOf(featureSummary: Record<string, unknown>): { ref: string; lines: string[] }[] {
  const accounts = Array.isArray(featureSummary.accounts) ? featureSummary.accounts : [];
  return accounts.flatMap((account: unknown) => {
    if (!account || typeof account !== 'object') return [];
    const { ref, profile } = account as { ref?: unknown; profile?: unknown };
    const parsed = abuseAssessmentAccountProfileSchema.safeParse(profile);
    return typeof ref === 'string' && parsed.success ? [{ ref, lines: describeAccountProfile(parsed.data) }] : [];
  });
}

const AccountProfiles: React.FC<{ featureSummary: Record<string, unknown> }> = ({ featureSummary }) => {
  const profiles = profilesOf(featureSummary);
  if (profiles.length === 0) return null;
  return (
    <Stack gap={0.5} sx={{ mt: 0.5 }} data-testid="shadow-detection-assessment-profiles">
      {profiles.map(({ ref, lines }) => (
        <Box key={ref}>
          <Typography level="body-xs" fontWeight="lg">
            {ref}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {lines.map(line => (
              <Typography key={line} component="li" level="body-xs">
                {line}
              </Typography>
            ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
};

const ResultChip: React.FC<{ item: AbuseAssessmentRow; testId?: string }> = ({ item, testId }) => (
  <StatusChip tone={RESULT_DISPLAY[item.result].tone} label={RESULT_DISPLAY[item.result].label} data-testid={testId} />
);

const LatestAssessment: React.FC<{ item: AbuseAssessmentRow }> = ({ item }) => (
  <Stack gap={0.75} data-testid="shadow-detection-assessment-latest">
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
      <ResultChip item={item} testId="shadow-detection-assessment-result" />
      {item.confidence !== null && (
        <Typography level="body-sm" data-testid="shadow-detection-assessment-confidence">
          Confidence {percent(item.confidence)}
        </Typography>
      )}
    </Stack>
    <AbuseAssessmentReasons reasons={item.reasons} />
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
      <AccountProfiles featureSummary={item.featureSummary} />
      <Box
        component="pre"
        sx={{ m: 0, mt: 0.5, p: 1, fontSize: 'xs', overflow: 'auto', maxHeight: '20rem', bgcolor: 'admin.canvas' }}
      >
        {JSON.stringify(item.featureSummary, null, 2)}
      </Box>
    </Box>
  </Stack>
);

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

type Props = { detectionId: string; enabled: boolean };

/** An advisory model assessment of one detection, shown beside the facts it was made from. */
export const ShadowDetectionAssessmentPanel: React.FC<Props> = ({ detectionId, enabled }) => {
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
        <LatestAssessment item={latest} />
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
