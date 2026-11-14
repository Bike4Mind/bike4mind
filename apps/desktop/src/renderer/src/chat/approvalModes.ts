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
 * The wording of 'full' is deliberately blunt and is not softened anywhere in the UI. Commands
 * run as the user with nothing confining them, so a mode that stops asking really does mean
 * any file this user can read may be read and handed to the model. A description
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
    description:
      'Runs everything except commands Desktop cannot follow, commands that write outside this project or write protected settings, reads of .env files, and repeated calls',
    tone: 'neutral',
  },
  {
    mode: 'full',
    label: 'Full access',
    description:
      'Runs commands and edits without asking, except commands Desktop cannot follow, deletes that cannot be undone, signed-in browser pages and changes to protected settings. Commands can read any file on this computer and reach the internet',
    tone: 'warning',
  },
];

/**
 * What the popover says about every mode at once.
 *
 * Kept as their own lines rather than folded into the rows because they hold whichever mode the
 * user picks, and hanging them off the orange row would read as reassurance attached to the one
 * option that has none to offer.
 *
 * The first two 'auto' lines are the ones that are not a limit, and they are here for the
 * opposite reason: 'auto' runs nearly everything, and the path check only sees paths written in
 * the command. Stating the gap where the reassurance is read is the only place stating it is any
 * use.
 */
export const APPROVAL_MODE_FOOTNOTES: readonly string[] = [
  'Commands run as you and are not confined to the folders you have shared; file edits are. "Approve for me" asks about the paths it can see a command name, which a script can still build at run time.',
  '"Approve for me" runs every other command and edit without asking, including builds, installs and downloads, as you.',
  '"Approve for me" asks before a command may write outside your folders, before a .env file is read, and when the same call is made three times in a row. A command that only reads outside your folders runs.',
  '"Approve for me" and "Full access" ask before commands Desktop cannot fully follow or parse, including git forms it does not list as safe. Only the listed Git operations with understood reference changes keep their usual behavior.',
  'Modeled commands that can send data off this computer can run without asking, whatever the reply has read. "Approve for me" asks about upload sources outside your shared folders. An unknown option or complex curl form asks in both modes. Scripts or test configs are judged on their own paths and risks.',
  'Deleting a conversation always asks, in every mode, because it cannot be undone.',
  'File edits into this app\'s own data folder or your credential folders such as ~/.ssh are refused in every mode. A command that names one is a path outside your folders, so "Approve for me" asks.',
  '"Full access" asks before an action that cannot be undone, acting in a browser page you are signed in to, and a command Desktop can see writes permission and hook settings or reaches this app\'s data or a credential folder. It also asks before a command that may reach a WSL distro this project has no folder in.',
  'Full access lasts until you quit: a conversation left on it reopens on "Ask for approval".',
  'A session the agent starts on its own never runs at full access; it inherits at most "Approve for me".',
  'A new conversation starts in the mode you picked last, except "Full access", which is never carried over.',
];

export function approvalModeOption(mode: ChatApprovalMode): ApprovalModeOption {
  return APPROVAL_MODE_OPTIONS.find(option => option.mode === mode) ?? APPROVAL_MODE_OPTIONS[0];
}

/** What the pill reads when there is a conversation open. Short enough not to crowd the row. */
export function approvalModeLabel(mode: ChatApprovalMode): string {
  return approvalModeOption(mode).label;
}
