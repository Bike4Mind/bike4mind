import { describe, expect, it } from 'vitest';
import { isConfirmableMcpTool, isCustomConnectorAction } from './confirmableMcpTool';

describe('isConfirmableMcpTool', () => {
  it.each([
    'create_issue',
    'add_issue_to_project',
    'jira_create_issue',
    'confluence_upload_attachment',
    'notion_create_page',
    'notion_append_blocks',
  ])('accepts the confirmable write tool %s', tool => expect(isConfirmableMcpTool(tool)).toBe(true));

  it.each(['image_generation', 'get_issue', 'jira_search_issues', 'notion_read_page', ''])('rejects %s', tool =>
    expect(isConfirmableMcpTool(tool)).toBe(false)
  );
});

describe('isCustomConnectorAction', () => {
  it('is true only when the action names a custom connector', () => {
    expect(isCustomConnectorAction({ customConnector: { slug: 'acme' } })).toBe(true);
    expect(isCustomConnectorAction({})).toBe(false);
  });
});
