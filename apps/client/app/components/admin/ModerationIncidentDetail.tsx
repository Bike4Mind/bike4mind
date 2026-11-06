import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  DialogActions,
  DialogContent,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Skeleton,
  Stack,
  Typography,
} from '@mui/joy';
import { Link } from '@tanstack/react-router';
import { INCIDENT_OVERRIDABLE_REVIEW_STATUSES } from '@bike4mind/common';
import { toast } from 'sonner';
import { AdminDialog, AdminPageHeader, Fact, SectionCard, StatusChip, formatUtc, relativeTime } from './shared';
import { REVIEW_STATUS_LABELS, formatConfidence, surfaceLabel } from './moderationIncidentLabels';
import {
  type ModerationVerdict,
  useModerationIncidentVerdict,
  useModerationIncidentView,
} from '@client/app/hooks/data/moderationIncidents';
import { getErrorMessage } from '@client/app/utils/error';

// The id the external reporting form returns; mirrors what the verdict route accepts.
const REPORT_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const REPORT_ID_MAX_LENGTH = 64;

type VerdictChoice = ModerationVerdict['kind'];

const VERDICT_SUCCESS: Record<VerdictChoice, string> = {
  no_action: 'Closed as correctly blocked.',
  false_positive: 'Marked as a false positive.',
  confirmed: 'Report id recorded.',
};

const UNAVAILABLE_COPY: Record<'no_stored_image' | 'not_displayable', string> = {
  no_stored_image:
    'No stored image exists for this incident. Generated and edited images are blocked before they are stored.',
  not_displayable: 'The stored file is not an image this page can display.',
};

type Props = { incidentId: string; onBack: () => void };

const Mono: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <Typography level="body-sm" fontFamily="code" data-testid={testId} sx={{ overflowWrap: 'anywhere' }}>
    {children}
  </Typography>
);

/** One verdict button with a plain line saying what it means. */
const VerdictOption: React.FC<{ button: React.ReactNode; help: string; testId: string }> = ({
  button,
  help,
  testId,
}) => (
  <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: 0.5, sm: 1.5 }} alignItems={{ sm: 'center' }}>
    <Box sx={{ flexShrink: 0, minWidth: { sm: '15rem' }, '& > button': { width: { xs: '100%', sm: 'auto' } } }}>
      {button}
    </Box>
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
      {help}
    </Typography>
  </Stack>
);

/**
 * One incident: who and what was flagged, the image behind a five-minute link, and the verdicts.
 * Opening it is an audited view; reloading the image is another one, because it signs a new link.
 */
export const ModerationIncidentDetail: React.FC<Props> = ({ incidentId, onBack }) => {
  const view = useModerationIncidentView(incidentId);
  const verdict = useModerationIncidentVerdict();
  const [dialog, setDialog] = useState<VerdictChoice | null>(null);
  const [reportId, setReportId] = useState('');
  // Keyed to the link that failed, so the fresh link a reload brings back clears it by itself.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const data = view.data;
  const reportIdValue = reportId.trim();
  const reportIdInvalid = reportIdValue.length > 0 && !REPORT_ID_PATTERN.test(reportIdValue);
  const canSubmitConfirmed =
    reportIdValue.length > 0 && reportIdValue.length <= REPORT_ID_MAX_LENGTH && !reportIdInvalid;
  const imageUrl = data?.image.availability === 'ready' ? data.image.url : null;
  const imageFailed = imageUrl !== null && failedUrl === imageUrl;
  const isPending = data?.reviewStatus === 'pending_review';
  // Mirrors the verdict route: a report can also be recorded over an earlier closing verdict.
  const canConfirm =
    isPending || INCIDENT_OVERRIDABLE_REVIEW_STATUSES.some(overridable => overridable === data?.reviewStatus);

  const closeDialog = () => {
    if (verdict.isPending) return;
    setDialog(null);
    setReportId('');
    verdict.reset();
  };

  const submit = (choice: VerdictChoice) =>
    verdict.mutate(
      {
        id: incidentId,
        verdict: choice === 'confirmed' ? { kind: 'confirmed', reportId: reportIdValue } : { kind: choice },
      },
      {
        onSuccess: () => {
          toast.success(VERDICT_SUCCESS[choice], {
            closeButton: true,
            position: 'bottom-left',
          });
          onBack();
        },
      }
    );

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md' }}
      data-testid="moderation-incident-detail"
    >
      <AdminPageHeader
        title="Moderation incident"
        description={incidentId}
        actions={
          <Button variant="outlined" onClick={onBack} data-testid="moderation-incident-back-btn">
            Back to queue
          </Button>
        }
      />

      {view.isPending && (
        <Stack gap={1} data-testid="moderation-incident-loading">
          <Skeleton variant="text" sx={{ width: '40%' }} />
          <Skeleton variant="rectangular" sx={{ width: '100%', maxWidth: 480, height: 320, borderRadius: 'sm' }} />
        </Stack>
      )}
      {view.error && (
        <Alert color="danger" data-testid="moderation-incident-error">
          {getErrorMessage(view.error)}
        </Alert>
      )}

      {data && (
        <>
          <Alert color="warning" data-testid="moderation-incident-classifier-note">
            This check is a general explicit-content classifier. It does not detect minors or CSAM. If anything suggests
            a minor, do not close this incident: escalate it and file a report.
          </Alert>

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
            <SectionCard title="Incident" data-testid="moderation-incident-meta">
              <Fact label="Time">{formatUtc(new Date(data.createdAt))}</Fact>
              <Fact label="Age">{relativeTime(new Date(data.createdAt), now)}</Fact>
              <Fact label="Status">
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <StatusChip
                    tone={isPending ? 'warn' : data.reviewStatus === 'confirmed_csam' ? 'bad' : 'neutral'}
                    label={REVIEW_STATUS_LABELS[data.reviewStatus]}
                    data-testid="moderation-incident-status"
                  />
                  {data.previousReviewStatus && (
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      overrode {REVIEW_STATUS_LABELS[data.previousReviewStatus]}
                    </Typography>
                  )}
                </Stack>
              </Fact>
              <Fact label="Surface" data-testid="moderation-incident-surface">
                {surfaceLabel(data.surface)}
              </Fact>
              <Fact label="Provider" data-testid="moderation-incident-provider">
                {data.provider}
              </Fact>
              <Fact label="Model" data-testid="moderation-incident-model">
                {data.model}
              </Fact>
              <Fact label="Session id">{data.sessionId && <Mono>{data.sessionId}</Mono>}</Fact>
              <Fact label="Quest id">{data.questId && <Mono>{data.questId}</Mono>}</Fact>
              {data.fabFileId && (
                <Fact label="File id">
                  <Mono>{data.fabFileId}</Mono>
                </Fact>
              )}
              <Fact label="Reviewer alert" data-testid="moderation-incident-alerted">
                {data.alertedAt ? formatUtc(new Date(data.alertedAt)) : 'No alert delivered yet'}
              </Fact>
              {data.lastReminderAt && (
                <Fact label="Last reminder" data-testid="moderation-incident-reminded">
                  {formatUtc(new Date(data.lastReminderAt))}
                </Fact>
              )}
              {data.falsePositiveAt && (
                <Fact label="False positive at" data-testid="moderation-incident-false-positive-at">
                  {formatUtc(new Date(data.falsePositiveAt))}
                </Fact>
              )}
              {data.reportedAt && (
                <Fact label="Report recorded at" data-testid="moderation-incident-reported-at">
                  {formatUtc(new Date(data.reportedAt))}
                </Fact>
              )}
              {data.ncmecReportId && (
                <Fact label="Report id">
                  <Mono>{data.ncmecReportId}</Mono>
                </Fact>
              )}
            </SectionCard>

            <Stack gap={2}>
              <SectionCard title="Flagged user" data-testid="moderation-incident-user">
                <Fact label="Account">
                  <Link
                    to="/admin/users/$userId"
                    params={{ userId: data.user.id }}
                    data-testid="moderation-incident-user-link"
                    style={{ textDecoration: 'none' }}
                  >
                    <Typography level="body-sm" sx={{ color: 'admin.link' }}>
                      {data.user.email ?? 'Account no longer exists'}
                    </Typography>
                  </Link>
                </Fact>
                <Fact label="User id">
                  <Mono testId="moderation-incident-user-id">{data.user.id}</Mono>
                </Fact>
              </SectionCard>

              <SectionCard title="Classifier labels" body="custom" data-testid="moderation-incident-labels">
                {data.labels.length === 0 ? (
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted', px: 2, py: 1.75 }}>
                    No labels were recorded for this incident.
                  </Typography>
                ) : (
                  <Box component="ul" sx={{ m: 0, px: 2, py: 1.75, listStyle: 'none', display: 'grid', gap: 1 }}>
                    {data.labels.map((label, index) => (
                      <Stack
                        key={`${label.name}-${index}`}
                        component="li"
                        direction="row"
                        gap={1}
                        alignItems="baseline"
                        data-testid={`moderation-incident-label-${index}`}
                      >
                        <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                          {label.name}
                        </Typography>
                        {label.parentName && (
                          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                            in {label.parentName}
                          </Typography>
                        )}
                        <Typography
                          level="body-sm"
                          sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums', color: 'admin.ink' }}
                        >
                          {formatConfidence(label.confidence)}
                        </Typography>
                      </Stack>
                    ))}
                  </Box>
                )}
              </SectionCard>
            </Stack>
          </Box>

          {data.image.availability === 'ready' ? (
            <Stack gap={1} data-testid="moderation-incident-image-panel">
              {imageFailed ? (
                <Alert color="warning" data-testid="moderation-incident-image-failed">
                  The image link expired or the stored file is gone.
                </Alert>
              ) : (
                // No download control: the link is inline-only and expires with the view.
                <Box
                  component="img"
                  src={data.image.url}
                  alt="Image under review"
                  referrerPolicy="no-referrer"
                  draggable={false}
                  onError={() => setFailedUrl(imageUrl)}
                  data-testid="moderation-incident-image"
                  sx={{
                    maxWidth: '100%',
                    maxHeight: '70vh',
                    objectFit: 'contain',
                    alignSelf: 'flex-start',
                    borderRadius: 'sm',
                  }}
                />
              )}
              <Stack direction="row" gap={1} alignItems="center">
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  This link works for five minutes. Reloading records another view.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  loading={view.isFetching}
                  onClick={() => void view.refetch()}
                  data-testid="moderation-incident-reload-btn"
                >
                  Reload image
                </Button>
              </Stack>
            </Stack>
          ) : (
            <Alert color="neutral" data-testid="moderation-incident-image-unavailable">
              {UNAVAILABLE_COPY[data.image.reason]}
            </Alert>
          )}

          {!isPending && (
            <Alert color="neutral" data-testid="moderation-incident-not-actionable">
              {data.reviewStatus === 'confirmed_csam'
                ? 'A report submission for this incident was left in an unknown state. It needs recovery before a verdict can be recorded here.'
                : data.reviewStatus === 'false_positive'
                  ? 'This incident was marked as a false positive. If a report was filed after all, you can still record its id with Record report.'
                  : data.reviewStatus === 'no_action'
                    ? 'This incident was closed as correctly blocked with nothing to report. If a report was filed after all, you can still record its id with Record report.'
                    : 'A verdict has already been recorded for this incident.'}
            </Alert>
          )}
          <Stack gap={1.5} data-testid="moderation-incident-verdicts">
            <VerdictOption
              testId="moderation-incident-no-action-help"
              help="The image was explicit and the block was right. Nothing suggests a minor, so there is nothing to report. Closes the incident."
              button={
                <Button
                  disabled={!isPending}
                  onClick={() => setDialog('no_action')}
                  data-testid="moderation-incident-no-action-btn"
                >
                  Close as correctly blocked
                </Button>
              }
            />
            <VerdictOption
              testId="moderation-incident-false-positive-help"
              help="The image was not explicit: the classifier was wrong. Closes the incident."
              button={
                <Button
                  variant="outlined"
                  color="neutral"
                  disabled={!isPending}
                  onClick={() => setDialog('false_positive')}
                  data-testid="moderation-incident-false-positive-btn"
                >
                  Mark false positive
                </Button>
              }
            />
            <VerdictOption
              testId="moderation-incident-confirmed-help"
              help="Only after you have filed a report on the external CyberTipline form. Records its report id and cannot be undone."
              button={
                <Button
                  color="danger"
                  variant="outlined"
                  disabled={!canConfirm}
                  onClick={() => setDialog('confirmed')}
                  data-testid="moderation-incident-confirmed-btn"
                >
                  Record report
                </Button>
              }
            />
          </Stack>
        </>
      )}

      <AdminDialog
        open={dialog === 'no_action'}
        onClose={closeDialog}
        title="Close as correctly blocked"
        data-testid="moderation-incident-no-action-dialog"
      >
        <DialogContent>
          <Typography level="body-sm">
            This records that the image was explicit and nothing suggests a minor, so no report is filed. The incident
            leaves the queue and its reminders stop. If a report is filed after all, you can still record it with Record
            report.
          </Typography>
          {verdict.error && dialog === 'no_action' && (
            <Alert color="danger" data-testid="moderation-incident-verdict-error">
              {getErrorMessage(verdict.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            loading={verdict.isPending}
            onClick={() => submit('no_action')}
            data-testid="moderation-incident-no-action-confirm-btn"
          >
            Close as correctly blocked
          </Button>
          <Button
            variant="plain"
            onClick={closeDialog}
            disabled={verdict.isPending}
            data-testid="moderation-incident-dialog-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </AdminDialog>

      <AdminDialog
        open={dialog === 'false_positive'}
        onClose={closeDialog}
        title="Mark as false positive"
        data-testid="moderation-incident-false-positive-dialog"
      >
        <DialogContent>
          <Typography level="body-sm">
            This records that the classifier was wrong: the image was not explicit. It closes the incident without a
            report and takes it out of the queue. It stays on file: if a report is filed after all, use Record report.
          </Typography>
          {verdict.error && dialog === 'false_positive' && (
            <Alert color="danger" data-testid="moderation-incident-verdict-error">
              {getErrorMessage(verdict.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            loading={verdict.isPending}
            onClick={() => submit('false_positive')}
            data-testid="moderation-incident-false-positive-confirm-btn"
          >
            Mark false positive
          </Button>
          <Button
            variant="plain"
            onClick={closeDialog}
            disabled={verdict.isPending}
            data-testid="moderation-incident-dialog-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </AdminDialog>

      <AdminDialog
        open={dialog === 'confirmed'}
        onClose={closeDialog}
        title="Record a filed report"
        data-testid="moderation-incident-confirmed-dialog"
      >
        <DialogContent>
          <Stack gap={2}>
            <Typography level="body-sm">
              File the report on the external reporting web form first, then enter the report id it gives you. This
              records that the report was filed and cannot be undone here.
            </Typography>
            <FormControl required error={reportIdInvalid}>
              <FormLabel>Report id</FormLabel>
              <Input
                value={reportId}
                onChange={event => setReportId(event.target.value)}
                slotProps={{
                  input: { maxLength: REPORT_ID_MAX_LENGTH, 'data-testid': 'moderation-incident-report-id-input' },
                }}
              />
              <FormHelperText data-testid="moderation-incident-report-id-hint">
                {reportIdInvalid ? 'Letters, digits and hyphens only.' : 'Enter the report id the web form gave you.'}
              </FormHelperText>
            </FormControl>
            {verdict.error && dialog === 'confirmed' && (
              <Alert color="danger" data-testid="moderation-incident-verdict-error">
                {getErrorMessage(verdict.error)}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="danger"
            loading={verdict.isPending}
            disabled={!canSubmitConfirmed}
            onClick={() => submit('confirmed')}
            data-testid="moderation-incident-confirmed-confirm-btn"
          >
            Record report
          </Button>
          <Button
            variant="plain"
            onClick={closeDialog}
            disabled={verdict.isPending}
            data-testid="moderation-incident-dialog-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </AdminDialog>
    </Stack>
  );
};

export default ModerationIncidentDetail;
