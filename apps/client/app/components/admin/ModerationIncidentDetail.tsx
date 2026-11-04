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
import { toast } from 'sonner';
import { AdminDialog, AdminPageHeader, StatusChip, formatUtc, relativeTime } from './shared';
import { VERDICT_EXPLANATIONS, formatConfidence, surfaceLabel } from './moderationIncidentLabels';
import {
  useModerationIncidentVerdict,
  useModerationIncidentView,
  type ModerationIncidentView,
} from '@client/app/hooks/data/moderationIncidents';
import { getErrorMessage } from '@client/app/utils/error';

// The id the external reporting form returns; mirrors what the verdict route accepts.
const REPORT_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const REPORT_ID_MAX_LENGTH = 64;

const STATUS_LABELS: Record<ModerationIncidentView['reviewStatus'], string> = {
  pending_review: 'Needs review',
  confirmed_csam: 'Report stuck',
  false_positive: 'False positive',
  reported: 'Reported',
};

const UNAVAILABLE_COPY: Record<'no_stored_image' | 'not_displayable', string> = {
  no_stored_image:
    'No stored image exists for this incident. Generated and edited images are blocked before they are stored.',
  not_displayable: 'The stored file is not an image this page can display.',
};

const MetaItem: React.FC<{ label: string; children: React.ReactNode; testId?: string }> = ({
  label,
  children,
  testId,
}) => (
  <Box data-testid={testId}>
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
      {label}
    </Typography>
    <Typography level="body-sm" component="div">
      {children}
    </Typography>
  </Box>
);

type Props = { incidentId: string; onBack: () => void };

/**
 * One incident: metadata, the image behind a five-minute link, and the two verdicts. Opening it is
 * an audited view; reloading the image is another one, because it signs a new link.
 */
export const ModerationIncidentDetail: React.FC<Props> = ({ incidentId, onBack }) => {
  const view = useModerationIncidentView(incidentId);
  const verdict = useModerationIncidentVerdict();
  const [dialog, setDialog] = useState<'false_positive' | 'confirmed' | null>(null);
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
  const canMarkFalsePositive = data?.reviewStatus === 'pending_review';
  // Mirrors the verdict route: a report can also be recorded over an earlier false positive.
  const canConfirm = canMarkFalsePositive || data?.reviewStatus === 'false_positive';

  const closeDialog = () => {
    if (verdict.isPending) return;
    setDialog(null);
    setReportId('');
    verdict.reset();
  };

  const submit = (choice: 'false_positive' | 'confirmed') =>
    verdict.mutate(
      {
        id: incidentId,
        verdict: choice === 'confirmed' ? { kind: 'confirmed', reportId: reportIdValue } : { kind: 'false_positive' },
      },
      {
        onSuccess: () => {
          toast.success(choice === 'confirmed' ? 'Report id recorded.' : 'Marked as a false positive.', {
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
          <Stack direction="row" gap={3} flexWrap="wrap" data-testid="moderation-incident-meta">
            <Box>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Time
              </Typography>
              <Typography level="body-sm">{formatUtc(new Date(data.createdAt))}</Typography>
            </Box>
            <Box>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Age
              </Typography>
              <Typography level="body-sm">{relativeTime(new Date(data.createdAt), now)}</Typography>
            </Box>
            <Box>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Surface
              </Typography>
              <Typography level="body-sm">{surfaceLabel(data.surface)}</Typography>
            </Box>
            <Box>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Status
              </Typography>
              <StatusChip
                tone={
                  data.reviewStatus === 'pending_review'
                    ? 'warn'
                    : data.reviewStatus === 'confirmed_csam'
                      ? 'bad'
                      : 'neutral'
                }
                label={STATUS_LABELS[data.reviewStatus]}
                data-testid="moderation-incident-status"
              />
            </Box>
          </Stack>

          <Stack gap={1} data-testid="moderation-incident-detection">
            <Typography level="title-sm">What was detected</Typography>
            {data.labels.length > 0 ? (
              <Stack component="ul" gap={0.5} sx={{ m: 0, pl: 2.5 }}>
                {[...data.labels]
                  .sort((a, b) => b.confidence - a.confidence)
                  .map(label => (
                    <Typography
                      component="li"
                      level="body-sm"
                      key={`${label.parentName}/${label.name}`}
                      data-testid="moderation-incident-label"
                    >
                      {label.parentName ? `${label.parentName} / ${label.name}` : label.name}
                      {' - '}
                      {formatConfidence(label.confidence)} confidence
                    </Typography>
                  ))}
              </Stack>
            ) : (
              <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="moderation-incident-no-labels">
                No detection labels were stored for this incident.
              </Typography>
            )}
            <Stack direction="row" gap={3} flexWrap="wrap">
              <MetaItem label="Provider" testId="moderation-incident-provider">
                {data.provider}
              </MetaItem>
              <MetaItem label="Model" testId="moderation-incident-model">
                {data.model}
              </MetaItem>
            </Stack>
          </Stack>

          <Stack gap={1} data-testid="moderation-incident-trail">
            <Typography level="title-sm">Review trail</Typography>
            <Stack direction="row" gap={3} flexWrap="wrap">
              <MetaItem label="Reviewer alert" testId="moderation-incident-alerted">
                {data.alertedAt ? `Sent ${formatUtc(new Date(data.alertedAt))}` : 'No alert delivered yet'}
              </MetaItem>
              {data.lastReminderAt && (
                <MetaItem label="Last reminder" testId="moderation-incident-reminded">
                  {formatUtc(new Date(data.lastReminderAt))}
                </MetaItem>
              )}
              {data.falsePositiveAt && (
                <MetaItem label="Marked false positive" testId="moderation-incident-false-positive-at">
                  {formatUtc(new Date(data.falsePositiveAt))}
                </MetaItem>
              )}
              {data.reportedAt && (
                <MetaItem label="Report recorded" testId="moderation-incident-reported-at">
                  {formatUtc(new Date(data.reportedAt))}
                  {data.reportChannel === 'manual' ? ' (filed on the web form)' : ''}
                </MetaItem>
              )}
              {data.ncmecReportId && (
                <MetaItem label="Report id" testId="moderation-incident-report-id">
                  {data.ncmecReportId}
                </MetaItem>
              )}
            </Stack>
            {data.previousReviewStatus === 'false_positive' && (
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="moderation-incident-overrode">
                A report was recorded over an earlier false-positive verdict.
              </Typography>
            )}
          </Stack>

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
              {UNAVAILABLE_COPY[data.image.reason]} Decide from the detection and review details above.
            </Alert>
          )}

          {!canMarkFalsePositive && (
            <Alert color="neutral" data-testid="moderation-incident-not-actionable">
              {data.reviewStatus === 'confirmed_csam'
                ? 'A report submission for this incident was left in an unknown state. It needs recovery before a verdict can be recorded here.'
                : data.reviewStatus === 'false_positive'
                  ? 'This incident was marked as a false positive. If a report was filed after all, you can still record its id with Record report.'
                  : 'A verdict has already been recorded for this incident.'}
            </Alert>
          )}
          <Stack gap={0.5} data-testid="moderation-incident-verdict-help">
            <Typography level="title-sm">What each verdict does</Typography>
            <Typography level="body-sm">
              <strong>Mark false positive:</strong> {VERDICT_EXPLANATIONS.false_positive}
            </Typography>
            <Typography level="body-sm">
              <strong>Record report:</strong> {VERDICT_EXPLANATIONS.confirmed}
            </Typography>
          </Stack>
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button
              variant="outlined"
              disabled={!canMarkFalsePositive}
              onClick={() => setDialog('false_positive')}
              data-testid="moderation-incident-false-positive-btn"
            >
              Mark false positive
            </Button>
            <Button
              color="danger"
              variant="outlined"
              disabled={!canConfirm}
              onClick={() => setDialog('confirmed')}
              data-testid="moderation-incident-confirmed-btn"
            >
              Record report
            </Button>
          </Stack>
        </>
      )}

      <AdminDialog
        open={dialog === 'false_positive'}
        onClose={closeDialog}
        title="Mark as false positive"
        data-testid="moderation-incident-false-positive-dialog"
      >
        <DialogContent>
          <Typography level="body-sm">
            This closes the incident without a report and takes it out of the queue. It stays on file: if a report is
            filed after all, open the incident from its alert email link and use Record report.
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
