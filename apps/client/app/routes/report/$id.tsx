import * as React from 'react';
import { Box, Button, FormControl, FormLabel, Option, Select, Sheet, Textarea, Typography } from '@mui/joy';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { ReportReason } from '@bike4mind/common';
import { reportPublishedArtifact } from '@client/app/utils/publishApi';

/**
 * /report/$id - report a public `/p/...` page for abuse.
 *
 * The served public pages run under a strict `script-src 'none'` CSP, so they
 * cannot host the interactive report form themselves; they link here (same app
 * origin) where the user is authenticated and the report API can be called with
 * their token. Auth-gated via layoutRoute, mirroring /share/$id.
 */

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'phishing', label: 'Phishing / impersonation' },
  { value: 'malware', label: 'Malware or malicious code' },
  { value: 'spam', label: 'Spam' },
  { value: 'abuse', label: 'Abusive or harmful content' },
  { value: 'copyright', label: 'Copyright violation' },
  { value: 'other', label: 'Other' },
];

const ReportPublicPage = () => {
  const { id } = useParams({ strict: false });
  const publicId = String(id ?? '');
  const navigate = useNavigate();

  const [reason, setReason] = React.useState<ReportReason | null>(null);
  const [details, setDetails] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState<null | 'reported' | 'already'>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await reportPublishedArtifact(publicId, { reason, details: details.trim() || undefined });
      setDone(res.alreadyReported ? 'already' : 'reported');
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setError(
        status === 404
          ? 'This page could not be found — it may have already been removed.'
          : 'Something went wrong submitting your report. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto', px: 2, py: 6 }} data-testid="report-page">
      <Sheet variant="outlined" sx={{ p: 3, borderRadius: 'lg' }}>
        {done ? (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <CheckCircleOutlineIcon color="success" sx={{ fontSize: 48 }} />
            <Typography level="title-lg" sx={{ mt: 1 }}>
              {done === 'already' ? 'You already reported this page' : 'Report submitted'}
            </Typography>
            <Typography level="body-sm" sx={{ mt: 1, opacity: 0.8 }}>
              Thanks — our team will review this page. Reported content is checked against our hosting policy and may be
              taken down.
            </Typography>
            <Button sx={{ mt: 3 }} onClick={() => navigate({ to: '/' })} data-testid="report-done-home">
              Back to Bike4Mind
            </Button>
          </Box>
        ) : (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <FlagOutlinedIcon sx={{ color: 'var(--joy-palette-danger-500)' }} />
              <Typography level="title-lg">Report this page</Typography>
            </Box>
            <Typography level="body-sm" sx={{ mb: 3, opacity: 0.8 }}>
              Flag <code>{publicId}</code> if it violates Bike4Mind&apos;s hosting policy (phishing, malware, spam, or
              abuse).
            </Typography>

            <FormControl sx={{ mb: 2 }} required>
              <FormLabel>Reason</FormLabel>
              <Select
                placeholder="Select a reason"
                value={reason}
                onChange={(_, v) => setReason(v)}
                data-testid="report-reason-select"
              >
                {REASONS.map(r => (
                  <Option key={r.value} value={r.value}>
                    {r.label}
                  </Option>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ mb: 2 }}>
              <FormLabel>Details (optional)</FormLabel>
              <Textarea
                minRows={3}
                maxRows={6}
                value={details}
                onChange={e => setDetails(e.target.value.slice(0, 2000))}
                placeholder="Add anything that helps us review this report"
                data-testid="report-details-input"
              />
            </FormControl>

            {error && (
              <Typography level="body-sm" color="danger" sx={{ mb: 2 }} data-testid="report-error">
                {error}
              </Typography>
            )}

            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button variant="plain" color="neutral" onClick={() => navigate({ to: '/' })}>
                Cancel
              </Button>
              <Button
                color="danger"
                loading={submitting}
                disabled={!reason}
                onClick={submit}
                data-testid="report-submit-btn"
              >
                Submit report
              </Button>
            </Box>
          </>
        )}
      </Sheet>
    </Box>
  );
};

export default ReportPublicPage;
