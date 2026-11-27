import { useState } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Typography from '@mui/joy/Typography';
import { isUnfinishedOutcome } from '@shared/agentOutcome';
import type { ChatChildReport, ChatMessage } from '@shared/chat';
import { LinkifiedText } from './ExternalLink';
import { BranchIcon, ChevronIcon } from './icons';
import { displayText } from './relayRows';
import { SessionLink } from './SessionLink';
import { messageScope } from './threadFind';

/** Where the child's work lives: "branch @ sha", either half alone, or null for a shared folder. */
export function workspaceLine(report: Pick<ChatChildReport, 'branch' | 'headSha'>): string | null {
  if (report.branch && report.headSha) return `${report.branch} @ ${report.headSha}`;
  return report.branch ?? report.headSha ?? null;
}

/**
 * A settled child's report in its parent's thread: the user-facing line, where its work is, and
 * its last reply folded away. The reply is another session's words, so it is drawn as plain text
 * (the same as SystemTurn draws the display line), never as markup.
 */
export function ChildReportCard({ message, report }: { message: ChatMessage; report: ChatChildReport }) {
  const [expanded, setExpanded] = useState(false);
  const failed = isUnfinishedOutcome(report.outcome);
  const where = workspaceLine(report);

  return (
    <Sheet
      variant="soft"
      color={failed ? 'danger' : 'neutral'}
      sx={{ px: 2, py: 1.25, borderRadius: 'md' }}
      data-testid="child-report-card"
      data-outcome={report.outcome}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', mb: 0.5 }}>
            From{' '}
            <SessionLink sessionId={report.sessionId} testId="child-report-open-link">
              a session you started
            </SessionLink>
          </Typography>
          <Typography
            level="body-sm"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            data-find-scope={messageScope(message.id)}
            data-testid="child-report-headline"
          >
            <LinkifiedText text={displayText(message)} />
          </Typography>
          {where && (
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              startDecorator={<BranchIcon />}
              sx={{ mt: 0.5, fontFamily: 'code', wordBreak: 'break-all', '& svg': { width: 12, height: 12 } }}
              data-testid="child-report-workspace"
            >
              {where}
            </Typography>
          )}
        </Box>
        {report.reply && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setExpanded(open => !open)}
            aria-label={expanded ? 'Hide its last reply' : 'Show its last reply'}
            aria-expanded={expanded}
            data-testid="child-report-expand-btn"
          >
            <ChevronIcon open={expanded} />
          </IconButton>
        )}
      </Box>
      {report.reply && expanded && (
        <Sheet
          variant="outlined"
          color="neutral"
          sx={{ mt: 1, px: 1.5, py: 1, borderRadius: 'sm', maxHeight: 320, overflowY: 'auto' }}
        >
          <Typography
            level="body-sm"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            data-testid="child-report-reply"
          >
            <LinkifiedText text={report.reply} />
          </Typography>
          {report.replyTruncated && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }} data-testid="child-report-truncated">
              Cut short. Open the session for the rest.
            </Typography>
          )}
        </Sheet>
      )}
    </Sheet>
  );
}
