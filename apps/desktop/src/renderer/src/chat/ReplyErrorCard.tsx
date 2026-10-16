import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import type { ChatErrorDetail } from '@shared/chat';
import { formatElapsed } from './statusLine';

/**
 * The clipboard text for a failed reply: everything the server logs can be searched by, plus the
 * time. One `Label: value` per line so it pastes cleanly into an issue or a chat.
 */
export function formatErrorDetails(detail: ChatErrorDetail, failedAt: string): string {
  const rows: [string, string | undefined][] = [
    ['Request ID', detail.requestId],
    ['Model', detail.model],
    ['Code', detail.code],
    ['Kind', detail.kind],
    ['Transport code', detail.transportCode],
    ['Upstream status', detail.upstreamStatus?.toString()],
    ['HTTP status', detail.httpStatus?.toString()],
    [
      'Elapsed',
      detail.elapsedMs === undefined ? undefined : `${formatElapsed(detail.elapsedMs)} (${detail.elapsedMs} ms)`,
    ],
    ['Time', failedAt],
  ];
  return rows
    .filter((row): row is [string, string] => row[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/**
 * Why a reply failed, in the server's own sanitized words. The copy action only appears when the
 * failure came from a completion request, since only then is there a request id to search for.
 */
export function ReplyErrorCard({
  error,
  detail,
  failedAt,
}: {
  error: string;
  detail?: ChatErrorDetail;
  failedAt: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!detail) return;
    void navigator.clipboard.writeText(formatErrorDetails(detail, failedAt)).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <Alert
      size="sm"
      color="danger"
      variant="soft"
      sx={{ mt: 1, alignItems: 'flex-start' }}
      data-testid="chat-message-error"
      endDecorator={
        detail ? (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={copy}
            sx={{ minHeight: 0, py: 0.25, px: 0.75, fontSize: 'xs', fontWeight: 'md', whiteSpace: 'nowrap' }}
            data-testid="chat-error-copy-btn"
          >
            {copied ? 'Copied' : 'Copy details'}
          </Button>
        ) : undefined
      }
    >
      {error}
    </Alert>
  );
}
