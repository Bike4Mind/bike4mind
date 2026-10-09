import { describe, it, expect } from 'vitest';
import { JIRA_ADD_WATCHER, JIRA_REMOVE_WATCHER } from '@bike4mind/mcp/atlassian/constants';
import {
  buildConfirmationButtons,
  formatPreviewFromParams,
  parseConfirmationButtonValue,
} from './confirmation-buttons';

const questId = '0123456789abcdef01234567';
const ts = 1700000000000;

const buttonValues = () => {
  const actions = buildConfirmationButtons(questId, ts).find(block => block.type === 'actions');
  const elements = (actions?.elements ?? []) as Array<{ action_id: string; value: string }>;
  return Object.fromEntries(elements.map(element => [element.action_id, element.value]));
};

describe('buildConfirmationButtons', () => {
  it('gives both buttons the questId:ts value', () => {
    expect(buttonValues()).toEqual({
      confirm_action: `${questId}:${ts}`,
      cancel_action: `${questId}:${ts}`,
    });
  });
});

describe('parseConfirmationButtonValue', () => {
  it('round-trips the value a button carries', () => {
    expect(parseConfirmationButtonValue(buttonValues().confirm_action)).toEqual({ questId, pendingActionTs: ts });
  });

  it('parses a bare quest id with no pending action ts', () => {
    const parsed = parseConfirmationButtonValue(questId);

    expect(parsed).toEqual({ questId });
    expect(parsed.pendingActionTs).toBeUndefined();
  });

  it('returns the whole value as the quest id when the suffix is not numeric', () => {
    expect(parseConfirmationButtonValue('abc:xyz')).toEqual({ questId: 'abc:xyz' });
  });

  it('parses an empty timestamp suffix as zero', () => {
    expect(parseConfirmationButtonValue('abc:')).toEqual({ questId: 'abc', pendingActionTs: 0 });
  });

  it('uses the final separator when a quest id contains a colon', () => {
    expect(parseConfirmationButtonValue('a:b:5')).toEqual({ questId: 'a:b', pendingActionTs: 5 });
  });
});

describe('formatPreviewFromParams watcher cards', () => {
  const accountId = '5b10ac8d82e05b22cc7d4ef5';

  it('names the resolved user next to the account the confirm will act on', () => {
    const text = formatPreviewFromParams(JIRA_ADD_WATCHER, {
      issueKey: 'PROJ-1',
      userIdentifier: accountId,
      displayName: 'Jane Doe',
    });

    expect(text).toContain('Add watcher:* Jane Doe (5b10ac8d82e05b22cc7d4ef5)');
    expect(text).toContain('PROJ-1');
  });

  it('falls back to the bare account when the lookup gave no name', () => {
    const text = formatPreviewFromParams(JIRA_REMOVE_WATCHER, { issueKey: 'PROJ-1', userIdentifier: accountId });

    expect(text).toContain(`Remove watcher:* ${accountId}`);
    expect(text).not.toContain('Parameters');
  });
});
