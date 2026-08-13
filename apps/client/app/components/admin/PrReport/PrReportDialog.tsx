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
    setText(next);
    // Edited text is a DIFFERENT digest, so it must not be absorbed as a duplicate of
    // the previous one. Re-keying on edit is what keeps the dedupe scoped to genuine
    // retries (a double-click, which does not change the text).
    setIdempotencyKey(crypto.randomUUID());
    if (sendState !== 'sending') {
      setSendState('idle');
      setFailure(null);
    }
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
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 'min(860px, 96vw)', maxHeight: '92vh', overflow: 'auto' }}>
        <DialogTitle>PR Status Digest</DialogTitle>
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

              <Tabs defaultValue="edit" size="sm">
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
                <Button size="sm" variant="outlined" color="warning" sx={{ mt: 1 }} onClick={confirmResendAfterUnknown}>
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
            <Button variant="plain" color="neutral" onClick={onClose}>
              Close
            </Button>
            <Button variant="outlined" onClick={runGenerate} loading={generate.isPending}>
              Regenerate
            </Button>
            <Button onClick={runSend} disabled={sendDisabled} loading={sendState === 'sending'}>
              Send to Slack
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
