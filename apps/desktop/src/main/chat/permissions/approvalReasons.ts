/**
 * Stable codes for why an approval card was shown, logged beside the free-text sentences so the
 * approval log can be counted without parsing prose. Each code is built next to the sentence it
 * stands for (shellTools.ts for the tool's own reasons, ChatService.awaitApproval for the gate's),
 * so the two cannot drift. Codes are only ever added: old log lines must keep their meaning.
 */
export const APPROVAL_REASON_CODES = [
  // A shell command's own reasons (shellTools.ts).
  'script-unchecked',
  'env-file-read',
  'outbound',
  'recursive-delete',
  'session-code',
  'git-hooks-changed',
  'git-program',
  'git-path-unplaced',
  'remote-clone',
  'protected-location',
  'unfollowable',
  'git-unlisted',
  'settings-write-unfollowable',
  'protected-unresolved',
  'wsl-distro-outside-project',
  'wsl-unnamed-distro',
  'wsl-system-distro',
  'wsl-management',
  'unreadable',
  'unreadable-wsl',
  // The gate's own reasons (ChatService.awaitApproval).
  'ask-rule',
  'loop',
  'outside-folders',
  'ask-mode',
  'irreversible',
  'tool-asks-in-auto',
  'tool-asks-in-full',
  'part-undecided',
  // A tool that asks by design: a folder request, an MCP server config, a question to the user.
  'interactive',
  // A card was shown but no cause was recorded; logged rather than omitted so gaps are countable.
  'unknown',
] as const;

export type ApprovalReasonCode = (typeof APPROVAL_REASON_CODES)[number];

/** A reason sentence and the code it is counted under. */
export type CodedReason = readonly [code: ApprovalReasonCode, sentence: string];
