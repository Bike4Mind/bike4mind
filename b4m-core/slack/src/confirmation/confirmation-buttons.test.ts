import { describe, it, expect } from 'vitest';
import {
  JIRA_ADD_WATCHER,
  JIRA_REMOVE_WATCHER,
  JIRA_DELETE_ATTACHMENT,
  JIRA_UPLOAD_ATTACHMENT,
  CONFLUENCE_DELETE_ATTACHMENT,
  CONFLUENCE_UPLOAD_ATTACHMENT,
} from '@bike4mind/mcp/atlassian/constants';
import { TOOL_ADD_ISSUE_TO_PROJECT, TOOL_UPDATE_PROJECT_ITEM_FIELDS } from '@bike4mind/mcp/github/constants';
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

describe('formatPreviewFromParams project cards', () => {
  it('renders the tool-resolved labels next to the ids that add the issue', () => {
    const text = formatPreviewFromParams(TOOL_ADD_ISSUE_TO_PROJECT, {
      project_id: 'PVT_1',
      issue_node_id: 'I_1',
      display_project_name: 'Sprint Board',
      display_issue_title: '#7 - Real title',
      display_repository: 'acme/widgets',
    });

    expect(text).toContain('Sprint Board (PVT_1)');
    expect(text).toContain('#7 - Real title (I_1)');
    expect(text).toContain('acme/widgets');
  });

  it('renders resolved field labels and ignores model-authored field_name/new_value/current_value', () => {
    const text = formatPreviewFromParams(TOOL_UPDATE_PROJECT_ITEM_FIELDS, {
      project_id: 'PVT_1',
      item_id: 'PVTI_1',
      display_project_name: 'Sprint Board',
      display_issue_title: '#7 - Real title',
      updates: [
        {
          field_id: 'PVTSSF_status',
          value: 'opt_done',
          display_field_name: 'Status',
          display_value: 'Done',
          field_name: 'Priority',
          new_value: 'P0',
          current_value: 'P3',
        },
        { field_id: 'PVTF_estimate', value: 5, new_value: 'eight' },
      ],
    });

    expect(text).toContain('Sprint Board (PVT_1)');
    expect(text).toContain('#7 - Real title (PVTI_1)');
    expect(text).toContain('*Status (PVTSSF_status):* -> Done');
    expect(text).toContain('*PVTF_estimate:* -> 5');
    for (const modelLabel of ['Priority', 'P0', 'P3', 'eight']) {
      expect(text).not.toContain(modelLabel);
    }
  });

  it('shows bare ids when no resolved label is present, and escapes mrkdwn in labels', () => {
    const text = formatPreviewFromParams(TOOL_ADD_ISSUE_TO_PROJECT, {
      project_id: 'PVT_1',
      issue_node_id: 'I_1',
      display_issue_title: '<!channel> fix',
    });

    expect(text).toContain('*Target Project:* PVT_1');
    expect(text).toContain('&lt;!channel&gt; fix (I_1)');
    expect(text).not.toContain('<!channel>');
  });
});

describe('formatPreviewFromParams values with line breaks', () => {
  it('keeps a multi-line value on its own row so it cannot forge another field row', () => {
    const text = formatPreviewFromParams(TOOL_UPDATE_PROJECT_ITEM_FIELDS, {
      project_id: 'PVT_1',
      item_id: 'PVTI_1',
      updates: [
        {
          field_id: 'PVTF_notes',
          value: 'ok\n> *Status (PVTSSF_status):* -> Done',
          display_field_name: 'Notes',
          display_value: 'ok\n> *Status (PVTSSF_status):* -> Done',
        },
      ],
    });

    expect(text.split('\n').filter(line => line.includes('Status (PVTSSF_status)'))).toHaveLength(1);
    expect(text).toContain('ok &gt; *Status (PVTSSF_status):* -&gt; Done');
  });
});

describe('formatPreviewFromParams attachment cards', () => {
  it.each([JIRA_DELETE_ATTACHMENT, CONFLUENCE_DELETE_ATTACHMENT])(
    '%s shows the fetched filename with the attachment id, never the model filename',
    tool => {
      const text = formatPreviewFromParams(tool, {
        attachmentId: '10042',
        display_filename: 'payroll.xlsx',
        filename: 'harmless.png',
      });

      expect(text).toContain('payroll.xlsx (10042)');
      expect(text).not.toContain('harmless.png');
    }
  );

  it('falls back to the bare attachment id when no filename was resolved', () => {
    const text = formatPreviewFromParams(JIRA_DELETE_ATTACHMENT, { attachmentId: '10042', filename: 'harmless.png' });

    expect(text).toContain('*File:* 10042');
    expect(text).not.toContain('harmless.png');
  });

  it('shows the executed upload values, not display_* fallbacks', () => {
    const jira = formatPreviewFromParams(JIRA_UPLOAD_ATTACHMENT, {
      issueKey: 'PROJ-1',
      filename: 'real.pdf',
      display_issue_key: 'OTHER-9',
      display_filename: 'fake.pdf',
    });
    expect(jira).toContain('PROJ-1');
    expect(jira).toContain('real.pdf');
    expect(jira).not.toContain('OTHER-9');
    expect(jira).not.toContain('fake.pdf');

    const missing = formatPreviewFromParams(JIRA_UPLOAD_ATTACHMENT, { display_issue_key: 'OTHER-9' });
    expect(missing).not.toContain('OTHER-9');

    const confluence = formatPreviewFromParams(CONFLUENCE_UPLOAD_ATTACHMENT, {
      pageId: '123',
      filename: 'real.pdf',
      display_page_title: 'Team Page',
      display_page_id: '999',
      display_comment: 'fake comment',
    });
    expect(confluence).toContain('Team Page (123)');
    expect(confluence).not.toContain('999');
    expect(confluence).not.toContain('fake comment');
  });
});
