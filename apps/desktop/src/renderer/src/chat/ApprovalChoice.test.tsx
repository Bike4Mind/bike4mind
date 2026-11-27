import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatApprovalChoice } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ApprovalChoiceButtons } from './ApprovalChoice';
import { APPROVAL_MODE_FOOTNOTES, APPROVAL_MODE_OPTIONS, approvalModeLabel, approvalModeOption } from './approvalModes';

/**
 * Rendered to a string, like DiffView's tests and for the same reason: this package's vitest
 * runs on `node`.
 *
 * That bounds what is asked here to the CLOSED card - the face of the split button, the branch
 * field and the standing-approval checkbox. The menu is a portal that mounts only once opened,
 * so which option a click sends is not answerable from this markup and is covered instead in
 * ChatService.spawnPlacement.test.ts, against the answers the gate actually receives.
 */
const CHOICE: ChatApprovalChoice = {
  options: [
    {
      id: 'worktree',
      label: 'Start with worktree',
      description: 'Its own checkout, beside the project.',
      field: { name: 'branch', label: 'Branch', value: 'agent/tidy-imports', hint: 'Based on feat/parent' },
    },
    { id: 'local', label: 'Start locally', description: 'Shares this working directory.' },
    { id: 'here', label: 'Do it here', description: 'No new session.', redirect: true },
  ],
};

function markup(choice = CHOICE): string {
  return renderToStaticMarkup(
    <ApprovalChoiceButtons
      choice={choice}
      onAnswer={() => {}}
      onDeny={() => {}}
      denyLabel="Don't start it"
      alwaysLabel="Always answer this way in this chat"
      testPrefix="chat-tool-approval"
    />
  );
}

describe('ApprovalChoiceButtons', () => {
  it('puts the first option on the face of the split button', () => {
    const html = markup();
    expect(html).toContain('data-testid="chat-tool-approval-option-worktree"');
    expect(html).toContain('Start with worktree');
    // And says what it means, since "worktree" alone does not carry the difference.
    expect(html).toContain('Its own checkout, beside the project.');
  });

  it('keeps the other options behind the caret rather than as buttons of their own', () => {
    const html = markup();
    expect(html).toContain('data-testid="chat-tool-approval-choice-more"');
    expect(html).not.toContain('data-testid="chat-tool-approval-option-local"');
    expect(html).not.toContain('data-testid="chat-tool-approval-option-here"');
  });

  it('shows the branch prefilled and editable, so a bad guess is fixable before anything exists', () => {
    const html = markup();
    expect(html).toContain('data-testid="chat-tool-approval-field-branch"');
    expect(html).toContain('value="agent/tidy-imports"');
  });

  it('names the base the branch is cut from beside the field, as text rather than a second input', () => {
    const html = markup();
    expect(html).toMatch(/data-testid="chat-tool-approval-hint-branch"[^>]*>Based on feat\/parent</);
    expect(html.match(/<input/g)).toHaveLength(2);
  });

  it('draws no hint for a field that has none', () => {
    const [worktree, ...rest] = CHOICE.options;
    const html = markup({
      options: [{ ...worktree, field: { name: 'branch', label: 'Branch', value: 'x' } }, ...rest],
    });
    expect(html).not.toContain('chat-tool-approval-hint-');
  });

  it('offers exactly one field, for the one option that needs one', () => {
    expect(markup().match(/chat-tool-approval-field-/g)).toHaveLength(1);
  });

  it('offers a standing approval as a checkbox, which is what lets it name WHICH option', () => {
    const html = markup();
    expect(html).toContain('data-testid="chat-tool-approval-always"');
    expect(html).toContain('Always answer this way in this chat');
  });

  it('still draws a deny beside the choice, so refusing outright stays one click', () => {
    expect(markup()).toContain('data-testid="chat-tool-approval-deny"');
  });

  it('draws no caret when there is nothing behind it', () => {
    const html = markup({ options: [CHOICE.options[0]] });
    expect(html).not.toContain('chat-tool-approval-choice-more');
    expect(html).toContain('data-testid="chat-tool-approval-option-worktree"');
  });
});

describe('approval mode copy', () => {
  it('offers the three modes safest first', () => {
    expect(APPROVAL_MODE_OPTIONS.map(option => option.mode)).toEqual(['ask', 'auto', 'full']);
  });

  /** The one coloured row. Two outliers would be no outlier at all. */
  it('marks exactly one option as the warning', () => {
    const flagged = APPROVAL_MODE_OPTIONS.filter(option => option.tone === 'warning');
    expect(flagged.map(option => option.mode)).toEqual(['full']);
  });

  /**
   * The honesty requirement. Commands are not confined, so a mode that stops asking
   * really does let a command read any file this user can read. Wording that implied
   * otherwise would be the most dangerous string in the app, so it is asserted rather than
   * left to whoever edits the copy next.
   */
  it('says plainly what full access allows', () => {
    const full = approvalModeOption('full');
    expect(full.description).toMatch(/read any file on this computer/i);
    expect(full.description).toMatch(/internet/i);
    expect(full.description).toMatch(/without asking/i);
  });

  it('names what full access still asks about', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/"Full access" asks before an action that cannot be undone/);
    expect(notes).not.toMatch(/credits/i);
    expect(notes).toMatch(/cannot be undone/i);
    expect(notes).toMatch(/opening a browser page you are signed in to/i);
    expect(notes).toMatch(/permission and hook settings/i);
    expect(notes).toMatch(/WSL distro this project has no folder in/i);
  });

  it('does not promise that approve-for-me checks everything', () => {
    expect(approvalModeOption('auto').description).toMatch(/everything except/i);
    expect(approvalModeOption('auto').description).toMatch(/write outside this project/i);
    expect(approvalModeOption('auto').description).toMatch(/write protected settings/i);
    expect(approvalModeOption('auto').description).toMatch(/cannot fully follow/i);
    expect(approvalModeOption('auto').description).not.toMatch(/external content/i);
  });

  it('says approve-for-me and full access ask for commands Desktop cannot parse or fully follow', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/ask before a command Desktop cannot parse or fully follow/);
    expect(notes).toMatch(/only reads outside your folders runs/i);
    expect(notes).toMatch(/explicit user permission rules still apply/i);
    expect(notes).not.toMatch(/after a reply reads web/i);
  });

  it('names the folders file edits can never reach', () => {
    expect(APPROVAL_MODE_FOOTNOTES.join(' ')).toMatch(/~\/\.ssh are refused in every mode/);
  });

  /** The limits that hold in every mode, plus the two scoping rules. */
  it('states the limits that hold in every mode', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/cannot be undone/i);
    expect(notes).toMatch(/folders you have shared/i);
    expect(notes).toMatch(/until you quit/i);
    expect(notes).toMatch(/never runs at full access/i);
  });

  /**
   * The other half of the honesty requirement, and the one that is easy to lose: 'auto' reads
   * as "unsafe things still ask", and builds, installs and downloads run unasked. The copy
   * has to say so, so the saying of it is asserted and not left to the next copy edit.
   */
  it('admits that approve-for-me runs most commands unasked', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/every other command and edit without asking/i);
  });

  it('falls back to asking for a mode it does not recognise', () => {
    expect(approvalModeLabel('ask')).toBe('Ask for approval');
    expect(approvalModeOption('nonsense' as never).mode).toBe('ask');
  });
});
