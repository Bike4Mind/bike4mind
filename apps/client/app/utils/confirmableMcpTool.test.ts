import { describe, expect, it } from 'vitest';
import { isConfirmableMcpTool } from './confirmableMcpTool';

describe('isConfirmableMcpTool', () => {
  it.each(['create_issue', 'add_issue_to_project', 'jira_create_issue', 'confluence_upload_attachment'])(
    'accepts the confirmable write tool %s',
    tool => expect(isConfirmableMcpTool(tool)).toBe(true)
  );

  it.each(['image_generation', 'get_issue', 'jira_search_issues', ''])('rejects %s', tool =>
    expect(isConfirmableMcpTool(tool)).toBe(false)
  );
});
