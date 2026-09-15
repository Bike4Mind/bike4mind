import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  Divider,
  Modal,
  ModalDialog,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Typography,
} from '@mui/joy';

import { useGeneratePrReport, useSendPrReport, type GenerateReportResult } from '@client/app/hooks/data/prReport';
import { PrReportPreview } from './PrReportPreview';

/**
 * PR report generator - the two-phase dialog.
 *
 * Generate → edit → preview → explicit send. The human in the middle is the whole
 * design: the classifier's output is a starting draft, not the last word, and nothing
 * reaches the channel without someone approving the exact text.
 *
 * The send control is also the client half of the double-post guarantee. It locks on
 * first submit, and on an uncertain delivery it STAYS locked behind a deliberate
 * confirmation with a fresh idempotency key - see `unknownDelivery` below.
 */

type SendState = 'idle' | 'sending' | 'sent' | 'deduped' | 'deliveryUnknown' | 'failed';

interface SendFailure {
  kind: string;
  reason?: string;
}

interface PrReportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrReportDialog({ open, onClose }: PrReportDialogProps) {
  const generate = useGeneratePrReport();
  const send = useSendPrReport();

  const [report, setReport] = useState<GenerateReportResult | null>(null);
  const [text, setText] = useState('');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');

  /**
   * All state transitions live in the mutation's own callbacks rather than in the
   * calling path, so the auto-generate effect below never sets state synchronously.
   */
  const runGenerate = useCallback(() => {
    generate.mutate(undefined, {
      onSuccess: result => {
        setReport(result);
        setText(result.text);
        // A new draft is a new send intent, so it gets its own key.
        setIdempotencyKey(crypto.randomUUID());
        setGenerateError(null);
        setFailure(null);
        setSendState('idle');
      },
      onError: error => {
        const data = (
          error as {
            response?: { data?: { kind?: string; reason?: string; rateLimit?: { retryAfterSeconds: number | null } } };
          }
        ).response?.data;

        if (data?.kind === 'rateLimited') {
          const retryAfter = data.rateLimit?.retryAfterSeconds;
          setGenerateError(
            retryAfter
              ? `GitHub is rate limiting this request. Retry in about ${retryAfter}s.`
              : 'GitHub is rate limiting this request. Retry shortly.'
          );
          return;
        }
        setGenerateError(data?.reason ?? 'Failed to generate the report.');
      },
    });
  }, [generate]);

  // Auto-generate on open: the draft is the starting point, and making the admin click
  // twice to see it adds nothing.
  useEffect(() => {
    if (open && !report && !generate.isPending) runGenerate();
    // Keyed on `open` alone, deliberately. The effect closes over
    // runGenerate/report/generate.isPending, but listing them (what exhaustive-deps
    // wants) re-runs it as they change and re-fires generation; the guard above is the
    // correctness check, not the dep array. This must fire once per open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onTextChange = (next: string) => {
    // A send in flight has already captured the text and key: ignore edits so the key is
    // not pointlessly rotated and the shown text cannot drift from what was actually
    // posted. The textarea is disabled in this state too - this is the belt to that
    // suspenders.
    if (sendState === 'sending') return;
    setText(next);
    // While a delivery is unconfirmed the gate stays shut: only confirmResendAfterUnknown
    // (a deliberate acknowledgement) may leave 'deliveryUnknown', and it mints its own
    // key. Re-arming here on a keystroke - or rotating the key - would let an edit silently
    // bypass the "check the channel" warning AND discard the key the server dedupe uses to
    // absorb an accidental identical retry. So leave text editable but state untouched.
    if (sendState === 'deliveryUnknown') return;
    // Edited text is a DIFFERENT digest, so it must not be absorbed as a duplicate of
    // the previous one. Re-keying on edit is what keeps the dedupe scoped to genuine
    // retries (a double-click, which does not change the text).
    setIdempotencyKey(crypto.randomUUID());
    setSendState('idle');
    setFailure(null);
  };

  const runSend = async () => {
    setSendState('sending');
    setFailure(null);
    try {
      const response = await send.mutateAsync({ text, idempotencyKey });
      setSendState(
        response.outcome === 'sent' ? 'sent' : response.outcome === 'deduped' ? 'deduped' : 'deliveryUnknown'
      );
    } catch (error) {
      const data = (error as { response?: { data?: SendFailure } }).response?.data;
      setFailure(data ?? { kind: 'unknown' });
      setSendState('failed');
    }
  };

  /**
   * Re-arm after an uncertain delivery. Requires BOTH a deliberate human action and a
   * fresh key.
   *
   * A client that treated `deliveryUnknown` as a plain failure and simply re-enabled
   * the button would hand the admin a retry that returns `deliveryUnknown` for the rest
   * of the window and then, once it lapses, posts for real - which is the double-post if
   * the original landed.
   */
  const confirmResendAfterUnknown = () => {
    setIdempotencyKey(crypto.randomUUID());
    setSendState('idle');
    setFailure(null);
  };

  const unknownDelivery = sendState === 'deliveryUnknown';
  const finished = sendState === 'sent' || sendState === 'deduped';
  const sendDisabled = !text.trim() || sendState === 'sending' || finished || unknownDelivery;

  return (
    // Neither an in-flight send NOR an unconfirmed delivery may be abandoned by
    // Escape/backdrop/Close. The parent unmounts on close, so the next open mints a fresh
    // key and re-enables Send - the exact double-post this dialog exists to prevent.
    // 'sending' would lose the mutation continuation; 'deliveryUnknown' would escape the "I
    // checked the channel" gate, whose whole point is that leaving it takes a deliberate
    // acknowledgement. An undefined onClose makes Joy's Modal non-dismissable in both.
    <Modal open={open} onClose={sendState === 'sending' || unknownDelivery ? undefined : onClose}>
      <ModalDialog
        aria-labelledby="pr-report-dialog-title"
        sx={{ width: 'min(860px, 96vw)', maxHeight: '92vh', overflow: 'auto' }}
      >
        <DialogTitle id="pr-report-dialog-title">PR Status Digest</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            Review and edit the draft below, then send it. Nothing is posted until you press Send.
          </Typography>

          {generate.isPending && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ my: 2 }}>
              <CircularProgress size="sm" />
              <Typography level="body-sm">Fetching open PRs…</Typography>
            </Stack>
          )}

          {generateError && (
            <Alert color="danger" variant="soft" sx={{ mb: 1 }}>
              {generateError}
            </Alert>
          )}

          {report && (
            <>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap' }}>
                <Chip size="sm" variant="soft">
                  {report.warnings.openPrListTruncated ? `${report.prCount}+ PRs` : `${report.prCount} PRs`}
                </Chip>
                {report.warnings.approvalDataUnavailable && (
                  <Chip size="sm" color="warning" variant="soft">
                    approval data unavailable
                  </Chip>
                )}
                {report.warnings.openPrListTruncated && (
                  <Chip size="sm" color="warning" variant="soft">
                    list truncated
                  </Chip>
                )}
              </Stack>

              {report.identityMapErrors.length > 0 && (
                <Alert color="warning" variant="soft" sx={{ mb: 1 }}>
                  <Box>
                    <Typography level="title-sm">Identity map has problems</Typography>
                    {report.identityMapErrors.map(error => (
                      <Typography key={`${error.line}-${error.reason}`} level="body-xs">
                        line {error.line}: {error.reason}
                      </Typography>
                    ))}
                  </Box>
                </Alert>
              )}

              {report.rosterWarnings?.length > 0 && (
                <Alert color="warning" variant="soft" sx={{ mb: 1 }}>
                  <Box>
                    <Typography level="title-sm">Some roster pools will not be mentioned</Typography>
                    <Typography level="body-xs">
                      Add these role keys to the identity map to @-mention their pool. The digest still posts.
                    </Typography>
                    {report.rosterWarnings.map(warning => (
                      <Typography key={`${warning.bucket}-${warning.reason}`} level="body-xs">
                        {warning.bucket}: {warning.reason}
                      </Typography>
                    ))}
                  </Box>
                </Alert>
              )}

              <Tabs defaultValue="edit" size="sm" aria-label="PR report edit and preview">
                <TabList>
                  <Tab value="edit">Edit</Tab>
                  <Tab value="preview">Preview mentions</Tab>
                </TabList>
                <TabPanel value="edit">
                  <Textarea
                    minRows={14}
                    maxRows={22}
                    value={text}
                    onChange={event => onTextChange(event.target.value)}
                    // Locked while a send is in flight so the shown text stays what was
                    // posted; still editable during deliveryUnknown so the admin can fix
                    // the draft before the deliberate re-send.
                    disabled={sendState === 'sending'}
                    slotProps={{ textarea: { style: { fontFamily: 'monospace', fontSize: '0.8rem' } } }}
                  />
                </TabPanel>
                <TabPanel value="preview">
                  <PrReportPreview
                    text={text}
                    mentionNames={report.mentionNames}
                    mentionNamesUnavailable={report.mentionNamesUnavailable}
                  />
                </TabPanel>
              </Tabs>
            </>
          )}

          {sendState === 'sent' && (
            <Alert color="success" variant="soft" sx={{ mt: 1 }}>
              Posted to Slack.
            </Alert>
          )}

          {sendState === 'deduped' && (
            <Alert color="success" variant="soft" sx={{ mt: 1 }}>
              Already posted - this retry was absorbed, so the channel received the digest exactly once.
            </Alert>
          )}

          {unknownDelivery && (
            <Alert color="warning" variant="soft" sx={{ mt: 1 }}>
              <Box>
                <Typography level="title-sm">Check the channel before retrying</Typography>
                <Typography level="body-sm">
                  The post was sent but Slack did not confirm it, so it may or may not have landed. Open the channel and
                  look. Only re-send if the digest is genuinely absent.
                </Typography>
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  sx={{ mt: 1 }}
                  onClick={confirmResendAfterUnknown}
                  data-testid="pr-report-confirm-resend-btn"
                >
                  I checked the channel - allow re-send
                </Button>
              </Box>
            </Alert>
          )}

          {sendState === 'failed' && failure && (
            <Alert color="danger" variant="soft" sx={{ mt: 1 }}>
              <Box>
                <Typography level="title-sm">
                  {failure.kind === 'notDelivered'
                    ? 'Nothing was posted - safe to retry'
                    : failure.kind === 'dedupeUnavailable'
                      ? 'Send was refused - nothing was posted'
                      : failure.kind === 'targetRejected'
                        ? 'Slack destination is not usable'
                        : 'Send failed'}
                </Typography>
                {failure.reason && <Typography level="body-sm">{failure.reason}</Typography>}
              </Box>
            </Alert>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              variant="plain"
              color="neutral"
              onClick={onClose}
              disabled={sendState === 'sending' || unknownDelivery}
              data-testid="pr-report-close-btn"
            >
              Close
            </Button>
            {/* Regenerate is locked while a send is in flight (its onSuccess would race the
                send continuation) and while a delivery is unconfirmed (it would reset to
                'idle' with a fresh key, bypassing the check-the-channel gate). */}
            <Button
              variant="outlined"
              onClick={runGenerate}
              loading={generate.isPending}
              disabled={generate.isPending || sendState === 'sending' || unknownDelivery}
              data-testid="pr-report-regenerate-btn"
            >
              Regenerate
            </Button>
            <Button
              onClick={runSend}
              disabled={sendDisabled}
              loading={sendState === 'sending'}
              data-testid="pr-report-send-btn"
            >
              Send to Slack
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
