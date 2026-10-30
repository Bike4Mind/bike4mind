import React from 'react';
import { Alert, Box, Skeleton, Stack, Typography } from '@mui/joy';
import type { RiskEvidenceFactName, RiskEvidenceFacts } from '@bike4mind/common';
import { useAdminRiskEvidence } from '@client/app/hooks/data/adminRiskEvidence';
import { ErrorState, RelativeTime, SectionCard, StatusChip, formatUtc } from '../../shared';

const FACT_LABELS: Record<RiskEvidenceFactName, string> = {
  signupNetwork: 'Signup network',
  edgeFingerprint: 'Edge fingerprint',
  wafSignals: 'WAF signals',
  authActivity: 'Sign-in activity',
  apiKeys: 'API keys',
  usage: 'Usage',
  concurrency: 'Concurrency',
  sensitiveActions: 'Sensitive actions',
};

const FACT_ORDER = Object.keys(FACT_LABELS) as RiskEvidenceFactName[];

const PROVENANCE_LABELS: Record<RiskEvidenceFacts[RiskEvidenceFactName]['provenance'], string> = {
  signup_request: 'Signup request',
  auth_events: 'Auth events',
  api_key_records: 'API key records',
  usage_ledger: 'Usage ledger',
  execution_state: 'Execution state',
  auth_audit_log: 'Auth audit log',
};

const MISSING_REASON_LABELS = { not_captured: 'Not captured', no_activity: 'No activity' } as const;

const EM_DASH = '\u2014';

const camelToWords = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase();

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

const formatValue = (key: string, value: unknown): string => {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number')
    return key === 'creditsSpent' ? `${numberFormat.format(Math.round(value))} credits` : numberFormat.format(value);
  return String(value);
};

const formatDate = (value: Date) => formatUtc(value);

const FactValue: React.FC<{ value: Record<string, unknown> }> = ({ value }) => (
  <Stack gap={0.25}>
    {Object.entries(value).map(([key, entry]) => (
      <Typography key={key} level="body-sm" sx={{ color: 'admin.ink' }}>
        {camelToWords(key)}: {formatValue(key, entry)}
      </Typography>
    ))}
  </Stack>
);

const FactRow: React.FC<{ name: RiskEvidenceFactName; fact: RiskEvidenceFacts[RiskEvidenceFactName] }> = ({
  name,
  fact,
}) => {
  const cell = { py: 1, px: 1.5, verticalAlign: 'top', borderTop: '1px solid', borderColor: 'admin.border' } as const;

  return (
    <Box component="tr" data-testid={`risk-evidence-fact-${name}`}>
      <Box component="td" sx={{ ...cell, color: 'admin.ink', fontWeight: 500 }}>
        {FACT_LABELS[name]}
      </Box>
      <Box component="td" sx={cell}>
        {fact.status === 'observed' && <StatusChip tone="info" label="Observed" />}
        {fact.status === 'missing' && <StatusChip tone="neutral" label="Unknown" />}
        {fact.status === 'failed' && <StatusChip tone="bad" label="Failed" />}
      </Box>
      <Box component="td" sx={cell}>
        {fact.status === 'observed' && <FactValue value={fact.value} />}
        {fact.status === 'missing' && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {MISSING_REASON_LABELS[fact.reason]}
          </Typography>
        )}
        {fact.status === 'failed' && (
          <Typography level="body-sm" color="danger">
            {fact.error}
          </Typography>
        )}
      </Box>
      <Box component="td" sx={{ ...cell, color: 'admin.inkMuted' }}>
        {PROVENANCE_LABELS[fact.provenance]}
      </Box>
      <Box component="td" sx={{ ...cell, color: 'admin.inkMuted' }}>
        {fact.status === 'observed' ? `${fact.sampleCount}${fact.truncated ? ' (capped)' : ''}` : EM_DASH}
      </Box>
      <Box component="td" sx={cell}>
        {fact.status === 'observed' &&
          (fact.latestAt ? (
            <RelativeTime at={fact.latestAt} />
          ) : (
            <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
              point sample
            </Typography>
          ))}
      </Box>
    </Box>
  );
};

const Muted: React.FC<{ children: React.ReactNode; 'data-testid'?: string }> = ({
  children,
  'data-testid': testId,
}) => (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
    {children}
  </Typography>
);

export const RiskEvidenceCard: React.FC<{ userId: string }> = ({ userId }) => {
  const { data, isLoading, isError, refetch } = useAdminRiskEvidence(userId);

  const body = () => {
    if (isLoading) {
      return (
        <Stack gap={1} sx={{ p: 2 }} data-testid="risk-evidence-loading">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="text" width="90%" />
          <Skeleton variant="text" width="75%" />
        </Stack>
      );
    }
    if (isError || !data) {
      return (
        <Box data-testid="risk-evidence-error">
          <ErrorState message="Risk evidence could not be loaded." onRetry={() => void refetch()} />
        </Box>
      );
    }

    const { evidence, evidenceUnreadable, riskScore, refresh } = data;
    return (
      <Stack gap={1.5} sx={{ p: 2 }}>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Shadow only - does not affect review state
        </Typography>
        {riskScore && (
          <Muted data-testid="risk-evidence-score">
            {`Signup score ${riskScore.score} (${riskScore.reviewState}), assessed ${formatDate(riskScore.computedAt)}`}
          </Muted>
        )}
        {refresh?.lastFailure && (
          <Alert color="warning" variant="soft" size="sm" data-testid="risk-evidence-failure-alert">
            {`Last refresh failed${refresh.lastFailureAt ? ` at ${formatDate(refresh.lastFailureAt)}` : ''}: ${refresh.lastFailure}`}
          </Alert>
        )}
        {refresh?.pendingSince && (
          <Muted data-testid="risk-evidence-pending">{`Refresh queued at ${formatDate(refresh.pendingSince)}`}</Muted>
        )}
        {!evidence ? (
          <Muted data-testid="risk-evidence-empty">
            {evidenceUnreadable
              ? 'Stored evidence is from another version and will be replaced on the next refresh'
              : 'No evidence collected yet'}
          </Muted>
        ) : (
          <>
            <Muted data-testid="risk-evidence-summary">
              {`Assessed ${formatDate(evidence.computedAt)} \u00b7 window ${formatDate(evidence.window.from)} - ${formatDate(evidence.window.to)} \u00b7 trigger: ${evidence.trigger.replace(/_/g, ' ')}`}
            </Muted>
            <Box sx={{ overflowX: 'auto' }}>
              <Box
                component="table"
                sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}
                data-testid="risk-evidence-table"
              >
                <Box component="thead" sx={{ color: 'admin.inkMuted' }}>
                  <tr>
                    {['Fact', 'Status', 'Value', 'Source', 'Samples', 'Freshness'].map(heading => (
                      <Box key={heading} component="th" sx={{ py: 0.75, px: 1.5, fontWeight: 500 }}>
                        {heading}
                      </Box>
                    ))}
                  </tr>
                </Box>
                <tbody>
                  {FACT_ORDER.map(name => (
                    <FactRow key={name} name={name} fact={evidence.facts[name]} />
                  ))}
                </tbody>
              </Box>
            </Box>
          </>
        )}
      </Stack>
    );
  };

  return (
    <SectionCard title="Risk evidence" body="custom" data-testid="risk-evidence-card">
      {body()}
    </SectionCard>
  );
};
