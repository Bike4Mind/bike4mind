import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

/**
 * Regression coverage for the formatted-vs-raw search contract.
 *
 * `searchIssues()` returns AI-facing formatted issues (flattened fields, description
 * reduced to plain text with HTML stripped). `searchIssuesRaw()` returns the raw Jira
 * response. Server-side analytics (liveops issue-tracker fingerprinting, history
 * analysis) MUST use the raw variant: the liveops fingerprint lives in an
 * `<!-- fingerprint:... -->` HTML comment that the formatter's HTML-stripping destroys,
 * and time-tracking fields are dropped entirely by the formatter.
 */
describe('JiraApi searchIssues vs searchIssuesRaw', () => {
  const FINGERPRINT = 'a'.repeat(40);
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;

  // A single raw issue whose description (ADF) embeds the liveops fingerprint comment.
  const rawIssue = {
    id: '10001',
    key: 'PROJ-1',
    fields: {
      summary: 'Login is broken',
      status: { name: 'Done' },
      issuetype: { name: 'Bug' },
      labels: ['liveops-triage'],
      created: '2026-01-01T00:00:00.000Z',
      resolutiondate: '2026-01-02T00:00:00.000Z',
      timespent: 3600,
      description: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: `Error details <!-- fingerprint:${FINGERPRINT} -->` }],
          },
        ],
      },
    },
  };

  const mockSearchResponse = () => ({
    ok: true,
    status: 200,
    headers: new Headers({}),
    text: async () => JSON.stringify({ issues: [rawIssue], total: 1, startAt: 0, maxResults: 50 }),
    json: async () => ({ issues: [rawIssue], total: 1, startAt: 0, maxResults: 50 }),
  });

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      agileApiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/agile/1.0',
      authHeader: 'Bearer test-token',
    };
    jiraApi = new JiraApi(mockConfig);
    global.fetch = vi.fn().mockResolvedValue(mockSearchResponse());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searchIssuesRaw() returns the unformatted issue with intact ADF + fingerprint', async () => {
    const result = await jiraApi.searchIssuesRaw({ jql: 'project = PROJ' });
    const issue = result.issues[0];

    // Raw shape: fields wrapper present, time-tracking field preserved.
    expect(issue.fields).toBeDefined();
    expect(issue.fields.summary).toBe('Login is broken');
    expect(issue.fields.timespent).toBe(3600);
    expect(issue.fields.resolutiondate).toBe('2026-01-02T00:00:00.000Z');

    // The fingerprint comment survives in the raw ADF description (the formatter would strip it).
    const adfText = issue.fields.description?.content?.[0]?.content?.[0]?.text as string;
    expect(adfText).toContain(`<!-- fingerprint:${FINGERPRINT} -->`);
  });

  it('searchIssues() returns the formatted (flattened) issue with HTML stripped', async () => {
    const result = await jiraApi.searchIssues({ jql: 'project = PROJ' });
    const issue = result.issues[0];

    // Formatted shape: fields are flattened to the top level, no `fields` wrapper.
    expect('fields' in issue).toBe(false);
    expect(issue.summary).toBe('Login is broken');
    expect(issue.status).toBe('Done');
    expect(issue.issueType).toBe('Bug');

    // The formatter strips HTML, so the fingerprint comment is gone, proving why
    // analytics consumers must use searchIssuesRaw() instead.
    expect(issue.description).not.toContain('<!--');
    expect(issue.description).toContain('Error details');
    expect(result.total).toBe(1);
  });
});
