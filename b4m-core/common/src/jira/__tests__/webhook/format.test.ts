import { describe, it, expect } from 'vitest';
import {
  formatIssueEventForSlack,
  formatCommentEventForSlack,
  formatSprintEventForSlack,
  formatGenericEventForSlack,
  escapeSlackMrkdwn,
  extractAdfText,
} from '../../webhook/format';
import {
  JiraIssueWebhookEvent,
  JiraCommentWebhookEvent,
  JiraSprintWebhookEvent,
  isIssueWebhookEvent,
  isCommentWebhookEvent,
  isSprintWebhookEvent,
  extractWebhookEventType,
} from '../../webhook/types';

const SITE_URL = 'https://test.atlassian.net';

function makeIssueEvent(overrides: Partial<JiraIssueWebhookEvent> = {}): JiraIssueWebhookEvent {
  return {
    timestamp: Date.now(),
    webhookEvent: 'jira:issue_created',
    issue: {
      id: '10001',
      key: 'PROJ-123',
      self: 'https://test.atlassian.net/rest/api/3/issue/10001',
      fields: {
        summary: 'Test issue summary',
        project: { id: '10000', key: 'PROJ', name: 'Test Project', self: '' },
        issuetype: { id: '1', name: 'Bug', self: '' },
        priority: { id: '2', name: 'High', self: '' },
        status: { id: '1', name: 'To Do', self: '', statusCategory: { id: 1, key: 'new', name: 'To Do', self: '' } },
        assignee: { accountId: 'user1', displayName: 'John Doe', self: '', emailAddress: '' },
        reporter: { accountId: 'user2', displayName: 'Jane Smith', self: '', emailAddress: '' },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      },
    },
    user: { accountId: 'user2', displayName: 'Jane Smith', self: '', emailAddress: '' },
    ...overrides,
  };
}

function makeCommentEvent(overrides: Partial<JiraCommentWebhookEvent> = {}): JiraCommentWebhookEvent {
  return {
    timestamp: Date.now(),
    webhookEvent: 'comment_created',
    issue: {
      id: '10001',
      key: 'PROJ-123',
      self: '',
      fields: {
        summary: 'Test issue summary',
        project: { id: '10000', key: 'PROJ', name: 'Test Project', self: '' },
        issuetype: { id: '1', name: 'Bug', self: '' },
        status: { id: '1', name: 'To Do', self: '', statusCategory: { id: 1, key: 'new', name: 'To Do', self: '' } },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      },
    },
    comment: {
      id: '10001',
      self: '',
      author: { accountId: 'user1', displayName: 'John Doe', self: '', emailAddress: '' },
      body: 'This is a comment',
      created: '2024-01-01T00:00:00.000Z',
      updated: '2024-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeSprintEvent(overrides: Partial<JiraSprintWebhookEvent> = {}): JiraSprintWebhookEvent {
  return {
    timestamp: Date.now(),
    webhookEvent: 'sprint_started',
    sprint: {
      id: 1,
      self: '',
      state: 'active',
      name: 'Sprint 1',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-14T00:00:00.000Z',
      originBoardId: 1,
    },
    user: { accountId: 'user1', displayName: 'John Doe', self: '', emailAddress: '' },
    ...overrides,
  };
}

describe('formatIssueEventForSlack', () => {
  it('should format issue created event', () => {
    const event = makeIssueEvent({ webhookEvent: 'jira:issue_created' });
    const result = formatIssueEventForSlack(event, SITE_URL);

    expect(result.text).toContain('PROJ-123');
    expect(result.text).toContain('created');
    expect(result.blocks).toHaveLength(5); // header, summary, metadata, context, actions
    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('Issue created') },
    });
  });

  it('should format issue updated event', () => {
    const event = makeIssueEvent({ webhookEvent: 'jira:issue_updated' });
    const result = formatIssueEventForSlack(event, SITE_URL);

    expect(result.text).toContain('updated');
    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('Issue updated') },
    });
  });

  it('should format issue deleted event', () => {
    const event = makeIssueEvent({ webhookEvent: 'jira:issue_deleted' });
    const result = formatIssueEventForSlack(event, SITE_URL);

    expect(result.text).toContain('deleted');
  });

  it('should include issue URL with site URL', () => {
    const event = makeIssueEvent();
    const result = formatIssueEventForSlack(event, SITE_URL);

    // Check the section block has the issue link
    const sectionBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('PROJ-123')
    );
    expect(sectionBlock).toBeDefined();
    expect((sectionBlock as { text: { text: string } }).text.text).toContain(`${SITE_URL}/browse/PROJ-123`);
  });

  it('should include priority, status, type, and assignee metadata', () => {
    const event = makeIssueEvent();
    const result = formatIssueEventForSlack(event, SITE_URL);

    const metaBlock = result.blocks[2];
    expect(metaBlock.type).toBe('section');
    const text = (metaBlock as { text: { text: string } }).text.text;
    expect(text).toContain('High');
    expect(text).toContain('To Do');
    expect(text).toContain('Bug');
    expect(text).toContain('John Doe');
  });

  it('should include changelog for updates', () => {
    const event = makeIssueEvent({
      webhookEvent: 'jira:issue_updated',
      changelog: {
        id: '1',
        items: [
          { field: 'status', fieldtype: 'jira', from: '1', to: '2', fromString: 'To Do', toString: 'In Progress' },
          {
            field: 'assignee',
            fieldtype: 'jira',
            from: null,
            to: 'user1',
            fromString: 'Unassigned',
            toString: 'John Doe',
          },
        ],
      },
    });
    const result = formatIssueEventForSlack(event, SITE_URL);

    const changeBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('Changes'));
    expect(changeBlock).toBeDefined();
    const text = (changeBlock as { text: { text: string } }).text.text;
    expect(text).toContain('To Do');
    expect(text).toContain('In Progress');
  });

  it('should include a View in Jira button', () => {
    const event = makeIssueEvent();
    const result = formatIssueEventForSlack(event, SITE_URL);

    const actionsBlock = result.blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const elements = (actionsBlock as { elements: Array<{ url: string; text: { text: string } }> }).elements;
    expect(elements[0].text.text).toBe('View in Jira');
    expect(elements[0].url).toBe(`${SITE_URL}/browse/PROJ-123`);
  });

  it('should handle missing assignee', () => {
    const event = makeIssueEvent();
    event.issue.fields.assignee = undefined as unknown as typeof event.issue.fields.assignee;
    const result = formatIssueEventForSlack(event, SITE_URL);

    const metaBlock = result.blocks[2];
    const text = (metaBlock as { text: { text: string } }).text.text;
    expect(text).toContain('Unassigned');
  });
});

describe('formatCommentEventForSlack', () => {
  it('should format comment created event', () => {
    const event = makeCommentEvent({ webhookEvent: 'comment_created' });
    const result = formatCommentEventForSlack(event, SITE_URL);

    expect(result.text).toContain('John Doe');
    expect(result.text).toContain('commented on');
    expect(result.text).toContain('PROJ-123');
    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('commented on') },
    });
  });

  it('should format comment updated event', () => {
    const event = makeCommentEvent({ webhookEvent: 'comment_updated' });
    const result = formatCommentEventForSlack(event, SITE_URL);

    expect(result.text).toContain('updated comment on');
  });

  it('should format comment deleted event', () => {
    const event = makeCommentEvent({ webhookEvent: 'comment_deleted' });
    const result = formatCommentEventForSlack(event, SITE_URL);

    expect(result.text).toContain('deleted comment on');
  });

  it('should include issue link and project context', () => {
    const event = makeCommentEvent();
    const result = formatCommentEventForSlack(event, SITE_URL);

    const contextBlock = result.blocks.find(b => b.type === 'context');
    expect(contextBlock).toBeDefined();
    const text = (contextBlock as { elements: Array<{ text: string }> }).elements[0].text;
    expect(text).toContain('Test Project');
  });
});

describe('formatSprintEventForSlack', () => {
  it('should format sprint started event', () => {
    const event = makeSprintEvent({ webhookEvent: 'sprint_started' });
    const result = formatSprintEventForSlack(event, SITE_URL);

    expect(result.text).toContain('Sprint 1');
    expect(result.text).toContain('started');
    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('Sprint started') },
    });
  });

  it('should format sprint closed event', () => {
    const event = makeSprintEvent({ webhookEvent: 'sprint_closed' });
    const result = formatSprintEventForSlack(event, SITE_URL);

    expect(result.text).toContain('completed');
  });

  it('should format sprint created event', () => {
    const event = makeSprintEvent({ webhookEvent: 'sprint_created' });
    const result = formatSprintEventForSlack(event, SITE_URL);

    expect(result.text).toContain('created');
  });

  it('should include sprint goal if present', () => {
    const event = makeSprintEvent();
    event.sprint.goal = 'Complete user auth';
    const result = formatSprintEventForSlack(event, SITE_URL);

    const goalBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('Goal'));
    expect(goalBlock).toBeDefined();
    expect((goalBlock as { text: { text: string } }).text.text).toContain('Complete user auth');
  });

  it('should include sprint dates', () => {
    const event = makeSprintEvent();
    const result = formatSprintEventForSlack(event, SITE_URL);

    const detailsBlock = result.blocks[1];
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('Start');
    expect(text).toContain('End');
  });

  it('should include View Board button', () => {
    const event = makeSprintEvent();
    const result = formatSprintEventForSlack(event, SITE_URL);

    const actionsBlock = result.blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const elements = (actionsBlock as { elements: Array<{ text: { text: string } }> }).elements;
    expect(elements[0].text.text).toBe('View Board');
  });
});

describe('formatGenericEventForSlack', () => {
  it('should format event type as human-readable header', () => {
    const result = formatGenericEventForSlack('issuelink_created', {}, SITE_URL);

    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('Issuelink Created') },
    });
    expect(result.text).toContain('Issuelink Created');
  });

  it('should strip jira: prefix from event type', () => {
    const result = formatGenericEventForSlack('jira:version_released', {}, SITE_URL);

    expect(result.blocks[0]).toMatchObject({
      type: 'header',
      text: { text: expect.stringContaining('Version Released') },
    });
  });

  it('should include issue details when present in payload', () => {
    const payload = {
      issue: {
        key: 'PROJ-456',
        fields: {
          summary: 'Fix the bug',
          status: { name: 'In Progress' },
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
          assignee: { displayName: 'Jane' },
          project: { key: 'PROJ', name: 'Project' },
        },
      },
      user: { displayName: 'John Doe' },
    };

    const result = formatGenericEventForSlack('custom_event', payload, SITE_URL);

    // Should have issue link
    const issueSection = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('PROJ-456')
    );
    expect(issueSection).toBeDefined();
    expect((issueSection as { text: { text: string } }).text.text).toContain(`${SITE_URL}/browse/PROJ-456`);

    // Should have View in Jira button
    const actionsBlock = result.blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeDefined();

    // Fallback text should include issue key
    expect(result.text).toContain('PROJ-456');
  });

  it('should include issue metadata (status, type, priority, assignee)', () => {
    const payload = {
      issue: {
        key: 'PROJ-456',
        fields: {
          summary: 'Fix the bug',
          status: { name: 'In Progress' },
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
          assignee: { displayName: 'Jane' },
        },
      },
    };

    const result = formatGenericEventForSlack('custom_event', payload, SITE_URL);

    // Find the details section (has metadata)
    const detailsBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('Status'));
    expect(detailsBlock).toBeDefined();
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('In Progress');
    expect(text).toContain('Bug');
    expect(text).toContain('High');
    expect(text).toContain('Jane');
  });

  it('should include issue link details when present', () => {
    const payload = {
      issueLink: {
        id: 12345,
        sourceIssueId: 10001,
        destinationIssueId: 10002,
        issueLinkType: {
          name: 'Blocks',
          outwardName: 'blocks',
          inwardName: 'is blocked by',
        },
      },
    };

    const result = formatGenericEventForSlack('issuelink_created', payload, SITE_URL);

    const detailsBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('Link type')
    );
    expect(detailsBlock).toBeDefined();
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('blocks');
    expect(text).toContain('10001');
    expect(text).toContain('10002');
  });

  it('should include version details when present', () => {
    const payload = {
      version: {
        name: 'v2.0.0',
        description: 'Major release',
        released: true,
      },
    };

    const result = formatGenericEventForSlack('jira:version_released', payload, SITE_URL);

    const detailsBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('Version')
    );
    expect(detailsBlock).toBeDefined();
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('v2.0.0');
    expect(text).toContain('Major release');
    expect(text).toContain('Released');
  });

  it('should include worklog details when present', () => {
    const payload = {
      worklog: {
        author: { displayName: 'John' },
        timeSpent: '2h 30m',
      },
      issue: { key: 'PROJ-1', fields: { summary: 'Task' } },
    };

    const result = formatGenericEventForSlack('worklog_created', payload, SITE_URL);

    const detailsBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('Time'));
    expect(detailsBlock).toBeDefined();
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('John');
    expect(text).toContain('2h 30m');
  });

  it('should include changelog when present', () => {
    const payload = {
      changelog: {
        items: [
          { field: 'status', fromString: 'Open', toString: 'Closed' },
          { field: 'resolution', fromString: 'None', toString: 'Done' },
        ],
      },
    };

    const result = formatGenericEventForSlack('some_event', payload, SITE_URL);

    const detailsBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('Changes')
    );
    expect(detailsBlock).toBeDefined();
    const text = (detailsBlock as { text: { text: string } }).text.text;
    expect(text).toContain('Open');
    expect(text).toContain('Closed');
    expect(text).toContain('resolution');
  });

  it('should include user and project in context', () => {
    const payload = {
      user: { displayName: 'John Doe' },
      project: { key: 'PROJ', name: 'Test Project' },
    };

    const result = formatGenericEventForSlack('some_event', payload, SITE_URL);

    const contextBlock = result.blocks.find(b => b.type === 'context');
    expect(contextBlock).toBeDefined();
    const text = (contextBlock as { elements: Array<{ text: string }> }).elements[0].text;
    expect(text).toContain('John Doe');
    expect(text).toContain('Test Project');
    expect(text).toContain('PROJ');
  });

  it('should handle empty payload gracefully', () => {
    const result = formatGenericEventForSlack('unknown_event', {}, SITE_URL);

    // Should have at least a header
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('Unknown Event');
  });

  it('should not include View in Jira button when no issue present', () => {
    const result = formatGenericEventForSlack('some_event', {}, SITE_URL);

    const actionsBlock = result.blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeUndefined();
  });
});

describe('escapeSlackMrkdwn', () => {
  it('should escape ampersands', () => {
    expect(escapeSlackMrkdwn('A & B')).toBe('A &amp; B');
  });

  it('should escape angle brackets to prevent link injection', () => {
    expect(escapeSlackMrkdwn('<http://evil.com|Click me>')).toBe('&lt;http://evil.com|Click me&gt;');
  });

  it('should escape bold markers', () => {
    expect(escapeSlackMrkdwn('*bold text*')).not.toContain('*');
  });

  it('should escape italic markers', () => {
    expect(escapeSlackMrkdwn('_italic text_')).not.toContain('_');
  });

  it('should escape strikethrough markers', () => {
    expect(escapeSlackMrkdwn('~strike~')).not.toContain('~');
  });

  it('should escape backtick markers', () => {
    expect(escapeSlackMrkdwn('`code`')).not.toContain('`');
  });

  it('should leave plain text unchanged', () => {
    expect(escapeSlackMrkdwn('Hello World 123')).toBe('Hello World 123');
  });
});

describe('formatters escape user-controlled content', () => {
  it('should escape malicious issue summary in issue formatter', () => {
    const event = makeIssueEvent();
    event.issue.fields.summary = '*bold* <http://evil.com|click>';
    const result = formatIssueEventForSlack(event, SITE_URL);

    // Summary section (block[1]) should not contain raw markdown
    const summaryBlock = result.blocks[1] as { text: { text: string } };
    expect(summaryBlock.text.text).not.toContain('*bold*');
    expect(summaryBlock.text.text).not.toContain('<http://evil.com');
  });

  it('should escape malicious display name in comment formatter', () => {
    const event = makeCommentEvent();
    event.comment.author.displayName = '<http://evil.com|Admin>';
    const result = formatCommentEventForSlack(event, SITE_URL);

    // Header should not contain active link
    const header = result.blocks[0] as { text: { text: string } };
    expect(header.text.text).not.toContain('<http://');
    expect(result.text).not.toContain('<http://');
  });

  it('should escape malicious sprint name and goal', () => {
    const event = makeSprintEvent();
    event.sprint.name = '*Evil Sprint* ~deleted~';
    event.sprint.goal = '`code injection` & <script>';
    const result = formatSprintEventForSlack(event, SITE_URL);

    const header = result.blocks[0] as { text: { text: string } };
    expect(header.text.text).not.toContain('*Evil Sprint*');

    const goalBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('Goal')) as {
      text: { text: string };
    };
    expect(goalBlock.text.text).not.toContain('`code injection`');
    expect(goalBlock.text.text).not.toContain('<script>');
  });

  it('should escape malicious content in generic formatter', () => {
    const payload = {
      issue: {
        key: 'PROJ-1',
        fields: {
          summary: '*bold* _italic_ ~strike~ `code` <http://evil.com|link>',
          status: { name: '*Hacked*' },
        },
      },
      user: { displayName: '<http://evil.com|Admin>' },
    };

    const result = formatGenericEventForSlack('test_event', payload, SITE_URL);

    // Check all mrkdwn blocks don't contain raw active markdown from user input
    for (const block of result.blocks) {
      if ('text' in block && block.text.type === 'mrkdwn') {
        expect(block.text.text).not.toContain('<http://evil.com');
      }
      if ('elements' in block) {
        for (const el of block.elements) {
          expect(el.text).not.toContain('<http://evil.com');
        }
      }
    }
  });
});

describe('extractAdfText', () => {
  it('should extract text from a simple ADF document', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    };
    expect(extractAdfText(adf)).toBe('Hello world');
  });

  it('should extract text from multiple paragraphs', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    };
    expect(extractAdfText(adf)).toBe('First paragraphSecond paragraph');
  });

  it('should handle inline formatting nodes', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' world' },
          ],
        },
      ],
    };
    expect(extractAdfText(adf)).toBe('Hello bold world');
  });

  it('should truncate text at maxLength', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A'.repeat(600) }] }],
    };
    const result = extractAdfText(adf, 100);
    expect(result).toBe('A'.repeat(100) + '...');
  });

  it('should return empty string for null/undefined', () => {
    expect(extractAdfText(null)).toBe('');
    expect(extractAdfText(undefined)).toBe('');
  });

  it('should return empty string for non-object input', () => {
    expect(extractAdfText('plain string')).toBe('');
    expect(extractAdfText(42)).toBe('');
  });

  it('should return empty string for non-ADF objects', () => {
    expect(extractAdfText({ type: 'not-a-doc' })).toBe('');
    expect(extractAdfText({ type: 'doc' })).toBe(''); // missing content array
    expect(extractAdfText({})).toBe('');
  });

  it('should handle empty ADF document', () => {
    expect(extractAdfText({ type: 'doc', version: 1, content: [] })).toBe('');
  });
});

describe('formatCommentEventForSlack - comment body', () => {
  it('should include comment body text for created comments', () => {
    const event = makeCommentEvent({
      webhookEvent: 'comment_created',
      comment: {
        id: '10001',
        self: '',
        author: { accountId: 'user1', displayName: 'John Doe', emailAddress: '' },
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'This is my comment' }] }],
        },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = formatCommentEventForSlack(event, SITE_URL);
    const bodyBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('This is my comment')
    );
    expect(bodyBlock).toBeDefined();
  });

  it('should not include comment body for deleted comments', () => {
    const event = makeCommentEvent({
      webhookEvent: 'comment_deleted',
      comment: {
        id: '10001',
        self: '',
        author: { accountId: 'user1', displayName: 'John Doe', emailAddress: '' },
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deleted comment text' }] }],
        },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = formatCommentEventForSlack(event, SITE_URL);
    const bodyBlock = result.blocks.find(
      b => b.type === 'section' && 'text' in b && b.text.text.includes('Deleted comment text')
    );
    expect(bodyBlock).toBeUndefined();
  });

  it('should handle non-ADF comment body gracefully', () => {
    const event = makeCommentEvent();
    // Plain string body (not ADF), should not crash
    (event.comment as Record<string, unknown>).body = 'just a string';

    const result = formatCommentEventForSlack(event, SITE_URL);
    // Should still produce valid output without body block
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('should escape malicious content in comment body', () => {
    const event = makeCommentEvent({
      comment: {
        id: '10001',
        self: '',
        author: { accountId: 'user1', displayName: 'John Doe', emailAddress: '' },
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '<http://evil.com|Click me> *bold*' }] }],
        },
        created: '2024-01-01T00:00:00.000Z',
        updated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = formatCommentEventForSlack(event, SITE_URL);
    const bodyBlock = result.blocks.find(b => b.type === 'section' && 'text' in b && b.text.text.includes('&gt;'));
    expect(bodyBlock).toBeDefined();
    // Should not contain raw active markdown
    expect((bodyBlock as { text: { text: string } }).text.text).not.toContain('<http://evil.com');
  });
});

describe('isIssueWebhookEvent', () => {
  it('should return true for valid issue event payload', () => {
    const payload = {
      webhookEvent: 'jira:issue_created',
      issue: {
        key: 'PROJ-1',
        fields: {
          summary: 'Test',
          status: { name: 'To Do' },
          issuetype: { name: 'Bug' },
          project: { key: 'PROJ' },
        },
      },
    };
    expect(isIssueWebhookEvent(payload)).toBe(true);
  });

  it('should reject payload with wrong event prefix', () => {
    expect(isIssueWebhookEvent({ webhookEvent: 'comment_created' })).toBe(false);
    expect(isIssueWebhookEvent({ webhookEvent: 'sprint_started' })).toBe(false);
  });

  it('should reject payload with missing webhookEvent', () => {
    expect(isIssueWebhookEvent({})).toBe(false);
    expect(isIssueWebhookEvent({ webhookEvent: 123 })).toBe(false);
    expect(isIssueWebhookEvent({ webhookEvent: '' })).toBe(false);
  });

  it('should reject payload with missing issue', () => {
    expect(isIssueWebhookEvent({ webhookEvent: 'jira:issue_created' })).toBe(false);
  });

  it('should reject payload with missing issue.key', () => {
    expect(isIssueWebhookEvent({ webhookEvent: 'jira:issue_created', issue: {} })).toBe(false);
    expect(isIssueWebhookEvent({ webhookEvent: 'jira:issue_created', issue: { key: 123 } })).toBe(false);
  });

  it('should reject payload with missing fields.summary', () => {
    expect(isIssueWebhookEvent({ webhookEvent: 'jira:issue_created', issue: { key: 'P-1', fields: {} } })).toBe(false);
    expect(
      isIssueWebhookEvent({ webhookEvent: 'jira:issue_created', issue: { key: 'P-1', fields: { summary: 42 } } })
    ).toBe(false);
  });

  it('should reject payload with missing nested required fields', () => {
    const base = {
      webhookEvent: 'jira:issue_created',
      issue: { key: 'P-1', fields: { summary: 'Test' } },
    };
    // Missing status
    expect(isIssueWebhookEvent(base)).toBe(false);

    // Missing issuetype
    expect(
      isIssueWebhookEvent({
        ...base,
        issue: { key: 'P-1', fields: { summary: 'Test', status: { name: 'Open' } } },
      })
    ).toBe(false);

    // Missing project
    expect(
      isIssueWebhookEvent({
        ...base,
        issue: {
          key: 'P-1',
          fields: { summary: 'Test', status: { name: 'Open' }, issuetype: { name: 'Bug' } },
        },
      })
    ).toBe(false);
  });
});

describe('isCommentWebhookEvent', () => {
  it('should return true for valid comment event payload', () => {
    const payload = {
      webhookEvent: 'comment_created',
      issue: { key: 'PROJ-1' },
      comment: { id: '123', author: { displayName: 'John' } },
    };
    expect(isCommentWebhookEvent(payload)).toBe(true);
  });

  it('should reject payload with wrong event prefix', () => {
    expect(isCommentWebhookEvent({ webhookEvent: 'jira:issue_created' })).toBe(false);
  });

  it('should reject payload with missing or invalid fields', () => {
    // Missing issue
    expect(isCommentWebhookEvent({ webhookEvent: 'comment_created' })).toBe(false);
    // Missing issue.key
    expect(isCommentWebhookEvent({ webhookEvent: 'comment_created', issue: {} })).toBe(false);
    // Missing comment
    expect(isCommentWebhookEvent({ webhookEvent: 'comment_created', issue: { key: 'P-1' } })).toBe(false);
    // Missing comment.id
    expect(isCommentWebhookEvent({ webhookEvent: 'comment_created', issue: { key: 'P-1' }, comment: {} })).toBe(false);
    // Non-string comment.id
    expect(
      isCommentWebhookEvent({ webhookEvent: 'comment_created', issue: { key: 'P-1' }, comment: { id: 123 } })
    ).toBe(false);
    // Missing author.displayName
    expect(
      isCommentWebhookEvent({
        webhookEvent: 'comment_created',
        issue: { key: 'P-1' },
        comment: { id: '1', author: {} },
      })
    ).toBe(false);
  });
});

describe('isSprintWebhookEvent', () => {
  it('should return true for valid sprint event payload', () => {
    const payload = {
      webhookEvent: 'sprint_started',
      sprint: { name: 'Sprint 1' },
    };
    expect(isSprintWebhookEvent(payload)).toBe(true);
  });

  it('should reject payload with wrong event prefix', () => {
    expect(isSprintWebhookEvent({ webhookEvent: 'jira:issue_created' })).toBe(false);
  });

  it('should reject payload with missing sprint', () => {
    expect(isSprintWebhookEvent({ webhookEvent: 'sprint_started' })).toBe(false);
  });

  it('should reject payload with missing sprint.name', () => {
    expect(isSprintWebhookEvent({ webhookEvent: 'sprint_started', sprint: {} })).toBe(false);
    expect(isSprintWebhookEvent({ webhookEvent: 'sprint_started', sprint: { name: 123 } })).toBe(false);
  });
});

describe('extractWebhookEventType', () => {
  it('should extract valid event type string', () => {
    expect(extractWebhookEventType({ webhookEvent: 'jira:issue_created' })).toBe('jira:issue_created');
    expect(extractWebhookEventType({ webhookEvent: 'comment_created' })).toBe('comment_created');
  });

  it('should return null for missing webhookEvent', () => {
    expect(extractWebhookEventType({})).toBeNull();
  });

  it('should return null for non-string webhookEvent', () => {
    expect(extractWebhookEventType({ webhookEvent: 123 })).toBeNull();
    expect(extractWebhookEventType({ webhookEvent: null })).toBeNull();
    expect(extractWebhookEventType({ webhookEvent: undefined })).toBeNull();
    expect(extractWebhookEventType({ webhookEvent: true })).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(extractWebhookEventType({ webhookEvent: '' })).toBeNull();
  });
});
