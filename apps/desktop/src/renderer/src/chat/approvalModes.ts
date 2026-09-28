import type { ChatApprovalMode } from '@shared/chat';

/**
 * How one approval mode reads in the popover and on the pill.
 *
 * `tone: 'warning'` is carried here rather than decided in the component so the one coloured
 * row is a property of the mode itself, testable without a DOM: exactly one option is the
 * outlier, and it is the one that removes the last thing standing between a crafted prompt and
 * the rest of the disk.
 */
export interface ApprovalModeOption {
  mode: ChatApprovalMode;
  label: string;
  description: string;
  tone: 'neutral' | 'warning';
}

/**
 * The three options, in the order they are offered: safest first.
 *
 * The wording of 'full' is deliberately blunt and is not softened anywhere in the UI. The
 * sandbox confines WRITES to the shared folders, but reads inside it are open - a command
 * needs /usr, /bin and the dynamic linker to run at all - so a mode that stops asking really
 * does mean any file this user can read may be read and handed to the model. A description
 * that implied otherwise would be the most dangerous string in the app.
 */
export const APPROVAL_MODE_OPTIONS: readonly ApprovalModeOption[] = [
  {
    mode: 'ask',
    label: 'Ask for approval',
    description: 'Always ask before running a command or changing a file',
    tone: 'neutral',
  },
  {
    mode: 'auto',
    label: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe',
    tone: 'neutral',
  },
  {
    mode: 'full',
    label: 'Full access',
    description: 'Runs anything without asking. Commands can read any file on this computer and reach the internet',
    tone: 'warning',
  },
];

/**
 * What the popover says about every mode at once.
 *
 * Kept as its own line rather than folded into the rows because all three are limits the user
 * keeps whichever they pick, and hanging them off the orange row would read as reassurance
 * attached to the one option that has none to offer.
 */
export const APPROVAL_MODE_FOOTNOTES: readonly string[] = [
  'In every mode, commands can only WRITE inside the folders you have shared, and credential stores (~/.ssh, ~/.aws, keychains) stay unreadable.',
  'Image, speech and music generation always ask, in every mode, because they spend credits.',
  'Deleting a conversation always asks, in every mode, because it cannot be undone.',
  'Full access lasts until you quit: a conversation left on it reopens on "Ask for approval".',
  'A session the agent starts on its own never runs at full access; it inherits at most "Approve for me".',
];

export function approvalModeOption(mode: ChatApprovalMode): ApprovalModeOption {
  return APPROVAL_MODE_OPTIONS.find(option => option.mode === mode) ?? APPROVAL_MODE_OPTIONS[0];
}

/** What the pill reads when there is a conversation open. Short enough not to crowd the row. */
export function approvalModeLabel(mode: ChatApprovalMode): string {
  return approvalModeOption(mode).label;
}
