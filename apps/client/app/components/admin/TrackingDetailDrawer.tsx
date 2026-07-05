/**
 * TrackingDetailDrawer - right-sliding drawer showing the full audit trail
 * for an SRE pipeline tracking document.
 *
 * Also exports TrackingDetailContent for inline (non-drawer) usage,
 * e.g. inside accordion cards on the Pipeline Status panel.
 */

import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Sheet,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import type { ISreErrorTracking } from '@bike4mind/database/infra';

interface TrackingDetailDrawerProps {
  trackingId: string | null;
  open: boolean;
  onClose: () => void;
}

export const STATUS_COLORS: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  detected: 'primary',
  analyzing: 'primary',
  awaiting_approval: 'warning',
  fixing: 'primary',
  fixed: 'success',
  already_fixed: 'warning',
  failed: 'danger',
  wont_fix: 'neutral',
  dispatch_failed: 'danger',
  dry_run: 'warning',
  scope_blocked: 'warning',
  approval_expired: 'warning',
  revision_requested: 'warning',
  recurrence_detected: 'danger',
  low_confidence: 'warning',
  rate_limited: 'warning',
  dismissed: 'neutral',
};

const CLASSIFICATION_COLORS: Record<string, 'danger' | 'warning' | 'neutral'> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
  SKIP: 'neutral',
};

export function formatDate(value: string | Date | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

/* TrackingDetailContent (reusable) */

interface TrackingDetailContentProps {
  doc: ISreErrorTracking | null;
}

export const TrackingDetailContent: React.FC<TrackingDetailContentProps> = ({ doc }) => {
  const handleCopyJson = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      toast('Full JSON copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleCopyFingerprint = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.errorFingerprint);
      toast('Fingerprint copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (!doc) return null;

  return (
    <Stack spacing={3}>
      {/* Overview */}
      <Section title="Overview">
        <Field label="Fingerprint">
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {doc.errorFingerprint}
            </Typography>
            <Tooltip title="Copy fingerprint">
              <IconButton size="sm" onClick={handleCopyFingerprint} data-testid="sre-tracking-copy-fingerprint">
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Field>
        <Field label="Source">
          <Chip size="sm" variant="soft">
            {doc.source}
          </Chip>
        </Field>
        {doc.repoSlug && (
          <Field label="Repository">
            <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
              {doc.repoSlug}
            </Typography>
          </Field>
        )}
        {doc.sourceRef && (
          <Field label="Source Ref">
            {doc.sourceRef.startsWith('http') ? (
              <Typography
                level="body-sm"
                component="a"
                href={doc.sourceRef}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ wordBreak: 'break-all' }}
              >
                {doc.sourceRef}
              </Typography>
            ) : (
              <Typography level="body-sm" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {doc.sourceRef}
              </Typography>
            )}
          </Field>
        )}
        {doc.errorMessage && (
          <Field label="Error Message">
            <Sheet
              variant="soft"
              sx={{
                p: 1.5,
                borderRadius: 'sm',
                maxHeight: 200,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {doc.errorMessage}
            </Sheet>
          </Field>
        )}
        {doc.affectedUserIds && doc.affectedUserIds.length > 0 && (
          <Field label="Affected Users">
            <Chip size="sm" variant="soft" color="warning">
              {doc.affectedUserIds.length} user{doc.affectedUserIds.length !== 1 ? 's' : ''}
            </Chip>
          </Field>
        )}
        {doc.dismissalReason && (
          <Field label="Dismissal">
            <Sheet variant="soft" color="neutral" sx={{ p: 1.5, borderRadius: 'sm' }}>
              <Typography level="body-sm" sx={{ mb: 0.5 }}>
                <strong>Reason:</strong> {doc.dismissalReason}
              </Typography>
              {doc.dismissedAt && (
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  Dismissed {formatDate(doc.dismissedAt)}
                  {doc.dismissedByUserId ? ` by ${doc.dismissedByUserId}` : ''}
                </Typography>
              )}
            </Sheet>
          </Field>
        )}
        {doc.originatingFromDismissedDocId && (
          <Field label="Originating Dismissal">
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
              {doc.originatingFromDismissedDocId}
            </Typography>
            <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
              This doc was created by a Rerun of a prior dismissed doc.
            </Typography>
          </Field>
        )}
      </Section>

      {/* Timeline */}
      <Section title="Timeline">
        <Stack spacing={1}>
          <TimelineEntry label="Detected" time={doc.createdAt} />
          <TimelineEntry label="Dispatched" time={doc.dispatchedAt} />
          <TimelineEntry label="Fix Merged" time={doc.fixMergedAt} />
          <TimelineEntry label="Users Notified" time={doc.userNotifiedAt} />
          <TimelineEntry label="Last Updated" time={doc.updatedAt} />
        </Stack>
        {doc.errorMessage &&
          (doc.status === 'failed' ||
            doc.status === 'wont_fix' ||
            doc.status === 'dispatch_failed' ||
            doc.status === 'scope_blocked' ||
            doc.status === 'approval_expired' ||
            doc.status === 'recurrence_detected' ||
            doc.status === 'low_confidence' ||
            doc.status === 'rate_limited') && (
            <Sheet
              variant="soft"
              color={
                doc.status === 'scope_blocked' ||
                doc.status === 'approval_expired' ||
                doc.status === 'low_confidence' ||
                doc.status === 'rate_limited'
                  ? 'warning'
                  : 'danger'
              }
              sx={{ p: 1, borderRadius: 'sm', mt: 1 }}
            >
              <Typography level="body-xs">{doc.errorMessage}</Typography>
            </Sheet>
          )}
      </Section>

      {/* Diagnosis */}
      <Section title="Diagnosis">
        {doc.diagnosisResult ? (
          <Stack spacing={1.5}>
            <Field label="Confidence">
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography level="body-sm" fontWeight="bold">
                  {doc.diagnosisResult.confidence}%
                </Typography>
                <Box
                  sx={{
                    width: 80,
                    height: 6,
                    borderRadius: 3,
                    bgcolor: 'background.level2',
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    sx={{
                      width: `${Math.min(doc.diagnosisResult.confidence, 100)}%`,
                      height: '100%',
                      bgcolor:
                        doc.diagnosisResult.confidence >= 70
                          ? 'success.500'
                          : doc.diagnosisResult.confidence >= 40
                            ? 'warning.500'
                            : 'danger.500',
                    }}
                  />
                </Box>
              </Stack>
            </Field>
            {doc.diagnosisResult.rootCause && (
              <Field label="Root Cause">
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
                  {doc.diagnosisResult.rootCause}
                </Sheet>
              </Field>
            )}
            {doc.diagnosisResult.proposedFix && (
              <Field label="Proposed Fix">
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
                  {doc.diagnosisResult.proposedFix}
                </Sheet>
              </Field>
            )}
            {doc.diagnosisResult.riskAssessment && (
              <Field label="Risk Assessment">
                <Typography level="body-sm">{doc.diagnosisResult.riskAssessment}</Typography>
              </Field>
            )}
            {doc.llmTokensUsed && (
              <Field label="LLM Tokens Used">
                <Typography level="body-xs">
                  Input: {doc.llmTokensUsed.input.toLocaleString()} | Output:{' '}
                  {doc.llmTokensUsed.output.toLocaleString()}
                </Typography>
              </Field>
            )}
          </Stack>
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
            Diagnosis not available — pipeline stopped at {doc.status}
          </Typography>
        )}
      </Section>

      {/* Affected Files (collapsed) */}
      <AccordionGroup>
        <Accordion>
          <AccordionSummary>
            <Typography level="title-sm">
              Affected Files
              {doc.diagnosisResult?.affectedFiles && (
                <Chip size="sm" variant="soft" sx={{ ml: 1 }}>
                  {doc.diagnosisResult.affectedFiles.length}
                </Chip>
              )}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            {doc.diagnosisResult?.affectedFiles?.length ? (
              <Stack spacing={2}>
                {doc.diagnosisResult.affectedFiles.map((file, i) => (
                  <Box key={i}>
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                      {file.filePath}
                    </Typography>
                    <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
                      Before:
                    </Typography>
                    <Sheet
                      variant="soft"
                      sx={{
                        p: 1,
                        borderRadius: 'sm',
                        maxHeight: 200,
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        whiteSpace: 'pre',
                        mb: 1,
                      }}
                    >
                      {file.before || '(empty)'}
                    </Sheet>
                    <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
                      After:
                    </Typography>
                    <Sheet
                      variant="soft"
                      sx={{
                        p: 1,
                        borderRadius: 'sm',
                        maxHeight: 200,
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        whiteSpace: 'pre',
                      }}
                    >
                      {file.after || '(empty)'}
                    </Sheet>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                No files identified
              </Typography>
            )}
          </AccordionDetails>
        </Accordion>

        {/* Tool Calls (collapsed) */}
        <Accordion>
          <AccordionSummary>
            <Typography level="title-sm">
              Tool Calls
              {doc.diagnosisResult?.toolCalls && (
                <Chip size="sm" variant="soft" sx={{ ml: 1 }}>
                  {doc.diagnosisResult.toolCalls.length}
                </Chip>
              )}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            {doc.diagnosisResult?.toolCalls?.length ? (
              <Stack spacing={2}>
                {doc.diagnosisResult.toolCalls.map((call, i) => (
                  <Box key={i}>
                    <Chip size="sm" variant="soft" color="primary" sx={{ mb: 0.5 }}>
                      {call.tool}
                    </Chip>
                    <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
                      Input:
                    </Typography>
                    <Sheet
                      variant="soft"
                      sx={{
                        p: 1,
                        borderRadius: 'sm',
                        maxHeight: 150,
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        mb: 1,
                      }}
                    >
                      {JSON.stringify(call.input, null, 2)}
                    </Sheet>
                    <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
                      Output:
                    </Typography>
                    <Sheet
                      variant="soft"
                      sx={{
                        p: 1,
                        borderRadius: 'sm',
                        maxHeight: 150,
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {call.output}
                    </Sheet>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                No tool calls recorded
              </Typography>
            )}
          </AccordionDetails>
        </Accordion>

        {/* Dry-Run Trace (collapsed) */}
        {doc.dryRunTrace && doc.dryRunTrace.length > 0 && (
          <Accordion>
            <AccordionSummary>
              <Typography level="title-sm">
                Dry-Run Trace
                <Chip size="sm" variant="soft" color="warning" sx={{ ml: 1 }}>
                  {doc.dryRunTrace.length}
                </Chip>
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
                {doc.dryRunTrace.map((entry, i) => (
                  <Box key={i}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                      <Chip size="sm" variant="soft" color="primary">
                        {entry.step}
                      </Chip>
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {new Date(entry.ts).toISOString().slice(11, 23)}
                      </Typography>
                    </Stack>
                    <Sheet
                      variant="soft"
                      sx={{
                        p: 1,
                        borderRadius: 'sm',
                        maxHeight: 120,
                        overflow: 'auto',
                        fontFamily: 'monospace',
                        fontSize: '0.7rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {JSON.stringify(entry.data, null, 2)}
                    </Sheet>
                  </Box>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        )}
      </AccordionGroup>

      {/* GitHub / Actions Links */}
      {(doc.githubIssueNumber ||
        doc.sourceRef?.includes('github.com') ||
        doc.fixPrNumber ||
        doc.workflowRunUrl ||
        doc.previousFixFingerprint) && (
        <Section title="Links">
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
            {doc.repoSlug && (doc.githubIssueNumber || doc.sourceRef?.includes('github.com')) && (
              <Button
                size="sm"
                variant="outlined"
                endDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                component="a"
                href={
                  doc.sourceRef?.includes('github.com')
                    ? doc.sourceRef
                    : `https://github.com/${doc.repoSlug}/issues/${doc.githubIssueNumber}`
                }
                target="_blank"
                rel="noopener noreferrer"
                data-testid="sre-tracking-link-issue"
              >
                Open Issue {doc.githubIssueNumber ? `#${doc.githubIssueNumber}` : ''}
              </Button>
            )}
            {doc.repoSlug && doc.fixPrNumber && (
              <Button
                size="sm"
                variant="outlined"
                endDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                component="a"
                href={`https://github.com/${doc.repoSlug}/pull/${doc.fixPrNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="sre-tracking-link-pr"
              >
                Open PR #{doc.fixPrNumber}
                {doc.fixPrSha ? ` (${doc.fixPrSha.slice(0, 7)})` : ''}
              </Button>
            )}
            {doc.workflowRunUrl && (
              <Button
                size="sm"
                variant="outlined"
                endDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                component="a"
                href={doc.workflowRunUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="sre-tracking-link-workflow"
              >
                Open Workflow Run
              </Button>
            )}
            {doc.previousFixFingerprint && (
              <Chip size="sm" variant="soft" color="warning">
                Previous fix: {doc.previousFixFingerprint.slice(0, 12)}...
              </Chip>
            )}
          </Stack>
        </Section>
      )}

      {/* Footer */}
      <Box sx={{ pt: 1 }}>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<ContentCopyIcon sx={{ fontSize: 14 }} />}
          onClick={handleCopyJson}
          data-testid="sre-tracking-copy-json"
        >
          Copy Full JSON
        </Button>
      </Box>
    </Stack>
  );
};

/* Drawer wrapper */

export const TrackingDetailDrawer: React.FC<TrackingDetailDrawerProps> = ({ trackingId, open, onClose }) => {
  const {
    data: doc,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['sre-tracking-detail', trackingId],
    queryFn: async () => {
      const { data } = await api.get<ISreErrorTracking>(`/api/sre/tracking/${trackingId}`);
      return data;
    },
    enabled: !!trackingId && open,
  });

  return (
    <Drawer anchor="right" open={open} onClose={onClose} size="lg">
      <Sheet sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Typography level="title-lg">Pipeline Trace</Typography>
            {doc && (
              <>
                <Chip size="sm" variant="soft" color={STATUS_COLORS[doc.status] || 'neutral'}>
                  {doc.status}
                </Chip>
                {doc.classification && (
                  <Chip size="sm" variant="soft" color={CLASSIFICATION_COLORS[doc.classification] || 'neutral'}>
                    {doc.classification}
                  </Chip>
                )}
                {doc.dryRun && (
                  <Chip size="sm" variant="soft" color="warning">
                    DRY RUN
                  </Chip>
                )}
              </>
            )}
          </Stack>
          <IconButton onClick={onClose} data-testid="sre-tracking-drawer-close">
            <CloseIcon />
          </IconButton>
        </Stack>

        {isLoading ? (
          <Typography>Loading details...</Typography>
        ) : isError ? (
          <Alert variant="soft" color="danger">
            Failed to load details{error instanceof Error ? `: ${error.message}` : ''}
          </Alert>
        ) : doc ? (
          <TrackingDetailContent doc={doc} />
        ) : null}
      </Sheet>
    </Drawer>
  );
};

/* Helper Components */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography level="title-sm" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 1 }}>
      <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.25 }}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

function TimelineEntry({ label, time }: { label: string; time: string | Date | undefined }) {
  if (!time) return null;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.500', flexShrink: 0 }} />
      <Typography level="body-xs" fontWeight="bold" sx={{ minWidth: 100 }}>
        {label}
      </Typography>
      <Typography level="body-xs">{formatDate(time)}</Typography>
    </Stack>
  );
}

export default TrackingDetailDrawer;
