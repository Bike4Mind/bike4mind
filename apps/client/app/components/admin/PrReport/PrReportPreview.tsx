import { Alert, Box, Link, Typography } from '@mui/joy';
import type { MarkupToken } from '@bike4mind/services';

import { tokenizeMarkupLine } from './tokenizeMarkupLine';

/**
 * PR report generator - the proofreading preview.
 *
 * Renders the generated mrkdwn as styled nodes so an admin can read WHO GETS PINGED
 * before approving the send. Mentions are the point: `<@U01ABCDEF>` tells a reader
 * nothing, while a name tells them whether the digest is about to nudge the right
 * people.
 */

interface PrReportPreviewProps {
  text: string;
  mentionNames: Record<string, string>;
  /**
   * When true the member-name lookup degraded, so some mentions below show raw ids.
   * Surfaced prominently: the risk is an admin approving a ping list they could not
   * actually read, and an empty name map looks identical to a digest that mentions
   * nobody.
   */
  mentionNamesUnavailable: boolean;
}

function TokenSpan({ token }: { token: MarkupToken }) {
  switch (token.kind) {
    case 'mention':
      return (
        <Box
          component="span"
          sx={{
            bgcolor: 'primary.softBg',
            color: 'primary.softColor',
            borderRadius: 'sm',
            px: 0.5,
            fontWeight: 'md',
          }}
        >
          @{token.name}
        </Box>
      );
    case 'link':
      return (
        <Link href={token.url} target="_blank" rel="noopener noreferrer">
          {token.label}
        </Link>
      );
    case 'bold':
      return <strong>{token.text}</strong>;
    case 'italic':
      return <em>{token.text}</em>;
    case 'text':
    default:
      return <>{token.text}</>;
  }
}

export function PrReportPreview({ text, mentionNames, mentionNamesUnavailable }: PrReportPreviewProps) {
  const lines = text.split('\n');

  return (
    <Box>
      {mentionNamesUnavailable && (
        <Alert color="warning" variant="soft" sx={{ mb: 1 }}>
          Slack name lookup was unavailable, so some mentions below show raw member IDs. The posted message is
          unaffected - Slack resolves the IDs itself - but this ping list could not be fully verified here.
        </Alert>
      )}

      <Box
        sx={{
          p: 1.5,
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          maxHeight: 420,
          overflowY: 'auto',
          overflowX: 'auto',
        }}
      >
        {lines.map((line, index) => (
          // Line index is a stable key here: the preview re-renders wholesale from a
          // single text blob and never reorders or splices individual lines.
          <Typography
            key={index}
            level="body-sm"
            sx={{ whiteSpace: 'pre-wrap', minHeight: line ? undefined : '0.75rem' }}
          >
            {tokenizeMarkupLine(line, mentionNames).map((token, tokenIndex) => (
              <TokenSpan key={tokenIndex} token={token} />
            ))}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
