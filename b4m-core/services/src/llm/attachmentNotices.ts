import type { FabFileNotice } from '@bike4mind/utils';

/**
 * Formatting for the per-file attachment notices `processFabFilesServer` produces. The same list is
 * said twice on a turn: once to the model (so it cannot answer as though a missing file were
 * present) and once to the user in the transcript (so a drop is never silent). Kept out of
 * ChatCompletionProcess so both wordings are testable on their own.
 */

/**
 * A session with a large workbench can drop many files at once; past this the list stops informing
 * and starts crowding the prompt and the banner. Both channels use the same cap so what the user
 * reads matches what the model was told.
 */
export const MAX_ATTACHMENT_NOTICE_LINES = 20;

const capped = (notices: FabFileNotice[]): { shown: FabFileNotice[]; overflow: number } => ({
  shown: notices.slice(0, MAX_ATTACHMENT_NOTICE_LINES),
  overflow: Math.max(0, notices.length - MAX_ATTACHMENT_NOTICE_LINES),
});

/** The transcript lines. One sentence per file, already user-facing. */
export function toAttachmentNoticeStrings(notices: FabFileNotice[]): string[] {
  const { shown, overflow } = capped(notices);
  const lines = shown.map(notice => notice.message);
  if (overflow > 0) lines.push(`...and ${overflow} more attachment(s) not listed here.`);
  return lines;
}

/**
 * The system message handed to the model. Rides in `fabMessages` so it lands in the `attachedFiles`
 * prompt source, which is highest-priority and caller-supplied - it therefore survives every prompt
 * mode, including raw. The closing instruction is the load-bearing part: without it the model reads
 * a list of file names and infers it has them.
 */
export function buildAttachmentNoticePrompt(notices: FabFileNotice[]): string {
  const { shown, overflow } = capped(notices);
  const lines = shown.map(notice => {
    const state = notice.delivered
      ? 'was delivered only in part - what is in this conversation is incomplete'
      : 'was NOT delivered and its content is not in this conversation';
    return `- ${state}: ${notice.message}`;
  });
  if (overflow > 0) lines.push(`- ...and ${overflow} more attachment(s) not listed here.`);

  return `# Attachment delivery problems

Files that should have been available for this turn did not arrive intact:

${lines.join('\n')}

Do not answer as though these files were present or complete. If the answer depends on one of them,
say plainly which file you do not have and why, and repeat the reason above to the user.`;
}
