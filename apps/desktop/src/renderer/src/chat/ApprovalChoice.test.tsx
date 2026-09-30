import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatApprovalChoice } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ApprovalChoiceButtons } from './ApprovalChoice';

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
      field: { name: 'branch', label: 'Branch', value: 'agent/tidy-imports' },
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
