import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  escapeSlackMrkdwn,
  handleSreApprovalAction,
  postSreAnalysisFailureMessage,
  postSreLowConfidenceMessage,
  postSreRateLimitedMessage,
  postSreFixSuccessMessage,
  postSreFixFailureMessage,
  postSreAlreadyFixedMessage,
  postSreFixLoopMessage,
} from '../../../server/integrations/slack/sreSlackApproval';

const mockGetSettingsValue = vi.fn();
const mockFindFullById = vi.fn();
const mockFindByIdWithToken = vi.fn();
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@slack/web-api', () => ({
  // Use a class so `new WebClient(token)` works - arrow functions are not constructors.
  // Class field initializers run at `new` time (not class-definition time), so
  // mockPostMessage is accessible even though vi.mock factories are hoisted.
  WebClient: class MockWebClient {
    chat = { postMessage: mockPostMessage };
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
  sreErrorTrackingRepository: {
    findById: vi.fn(),
    findFullById: (...args: unknown[]) => mockFindFullById(...args),
    atomicTransition: vi.fn(),
  },
  slackDevWorkspaceRepository: {
    findByIdWithToken: (...args: unknown[]) => mockFindByIdWithToken(...args),
  },
}));

const mockResolveFullConfig = vi.fn().mockReturnValue({ slack: { approverIds: '' } });

vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@bike4mind/common');
  return {
    ...actual,
    SreAgentConfigSchema: {
      parse: vi.fn((v: unknown) => v ?? { repos: [] }),
    },
    SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
    resolveFullConfig: (...args: unknown[]) => mockResolveFullConfig(...args),
  };
});

describe('escapeSlackMrkdwn', () => {
  it('should escape angle brackets', () => {
    expect(escapeSlackMrkdwn('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('should escape ampersands', () => {
    expect(escapeSlackMrkdwn('foo & bar')).toBe('foo &amp; bar');
  });

  it('should escape Slack link injection', () => {
    expect(escapeSlackMrkdwn('<https://evil.com|phishing>')).toBe('&lt;https://evil.com|phishing&gt;');
  });

  it('should preserve @here (not escaped by this helper)', () => {
    expect(escapeSlackMrkdwn('@here please check')).toBe('@here please check');
  });

  it('should return normal text unchanged', () => {
    expect(escapeSlackMrkdwn('Normal error message without special chars')).toBe(
      'Normal error message without special chars'
    );
  });

  it('should handle all special chars together', () => {
    expect(escapeSlackMrkdwn('x < y & z > w')).toBe('x &lt; y &amp; z &gt; w');
  });

  it('should handle empty string', () => {
    expect(escapeSlackMrkdwn('')).toBe('');
  });
});

describe('postSreAnalysisFailureMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreAnalysisFailureMessage(
        'tracking-1',
        'fp-abc123',
        'TypeError: Cannot read properties of undefined',
        'Circuit breaker open (repo: 5 consecutive failures)',
        'https://github.com/MillionOnMars/lumina5/issues/123',
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreLowConfidenceMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreLowConfidenceMessage(
        'tracking-2',
        { rootCause: 'Null pointer in auth middleware', confidence: 45 },
        'TypeError: Cannot read property of null',
        'fp-def456',
        { askThreshold: 60 },
        'https://github.com/MillionOnMars/lumina5/issues/456',
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreRateLimitedMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreRateLimitedMessage(
        'tracking-3',
        { rootCause: 'Missing null check in query builder', confidence: 82 },
        'ReferenceError: query is not defined',
        'fp-ghi789',
        { fixesToday: 5, maxFixesPerDay: 5 },
        'https://github.com/MillionOnMars/lumina5/issues/789',
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreFixSuccessMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreFixSuccessMessage(
        'tracking-4',
        'fp-jkl012',
        'TypeError: Cannot read properties of undefined',
        8200,
        'https://github.com/MillionOnMars/lumina5/pull/8200',
        undefined,
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreFixFailureMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreFixFailureMessage(
        'tracking-5',
        'fp-mno345',
        'ReferenceError: db is not defined',
        'Workflow step "apply-fix" exited with code 1',
        undefined,
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreAlreadyFixedMessage', () => {
  it('returns without throwing when slack is not configured', async () => {
    await expect(
      postSreAlreadyFixedMessage(
        'tracking-6',
        'SyntaxError: Unexpected token',
        'fp-pqr678',
        undefined,
        'MillionOnMars/lumina5',
        undefined,
        {} // no workspaceId/channelId
      )
    ).resolves.toBeUndefined();
  });
});

describe('postSreAlreadyFixedMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('strips > and | from workflowRunUrl before embedding in mrkdwn link', async () => {
    await postSreAlreadyFixedMessage(
      'tracking-6',
      'SyntaxError: Unexpected token',
      'fp-pqr678',
      undefined,
      'MillionOnMars/lumina5',
      'https://github.com/org/repo/actions/runs/9|injected>text',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    const args = mockPostMessage.mock.calls[0][0];
    const blockText = JSON.stringify(args.blocks);
    expect(blockText).not.toContain('|injected');
    expect(blockText).not.toMatch(/injected>text/);
  });
});

describe('postSreFixSuccessMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('posts blocks and includes PR link', async () => {
    await postSreFixSuccessMessage(
      'tracking-1',
      'fp-abc123',
      'TypeError: Cannot read property',
      100,
      'https://github.com/org/repo/pull/100',
      undefined,
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const args = mockPostMessage.mock.calls[0][0];
    const blockText = JSON.stringify(args.blocks);
    expect(blockText).toContain('github.com/org/repo/pull/100');
    expect(blockText).toContain('#100');
  });

  it('strips > and | from workflowRunUrl before embedding in mrkdwn link', async () => {
    await postSreFixSuccessMessage(
      'tracking-1',
      'fp-abc123',
      'TypeError: bad',
      100,
      'https://github.com/org/repo/pull/100',
      'https://github.com/org/repo/actions/runs/1|injected>text',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    const args = mockPostMessage.mock.calls[0][0];
    const prSection = (args.blocks as Array<{ type: string; text?: { text: string } }>).find(
      b => b.type === 'section' && b.text?.text.includes('PR:')
    );
    expect(prSection?.text?.text).not.toContain('|injected');
    expect(prSection?.text?.text).not.toMatch(/injected>text/);
  });

  it('strips > and | from prUrl before embedding in mrkdwn link', async () => {
    await postSreFixSuccessMessage(
      'tracking-1',
      'fp-abc123',
      'TypeError: bad',
      100,
      'https://github.com/org/repo/pull/100|injected>text',
      undefined,
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    const args = mockPostMessage.mock.calls[0][0];
    // Find the section block containing the PR link
    const prBlock = (args.blocks as Array<{ type: string; text?: { text: string } }>).find(
      b => b.type === 'section' && b.text?.text.includes('PR:')
    );
    expect(prBlock?.text?.text).not.toContain('|injected');
    expect(prBlock?.text?.text).not.toMatch(/injected>text/);
  });
});

describe('postSreAlreadyFixedMessage — conditional actions block', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('omits actions block when githubIssueNumber is undefined', async () => {
    await postSreAlreadyFixedMessage(
      'tracking-1',
      'SyntaxError: bad',
      'fp-abc123',
      undefined,
      'MillionOnMars/lumina5',
      undefined,
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{ type: string }>;
    expect(blocks.some(b => b.type === 'actions')).toBe(false);
  });

  it('includes actions block with GitHub Issue button when githubIssueNumber is set', async () => {
    await postSreAlreadyFixedMessage(
      'tracking-1',
      'SyntaxError: bad',
      'fp-abc123',
      999,
      'MillionOnMars/lumina5',
      undefined,
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{
      type: string;
      elements?: Array<{ url?: string }>;
    }>;
    const actionsBlock = blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock?.elements?.[0]?.url).toContain('/issues/999');
  });
});

describe('handleSreApprovalAction — authorization', () => {
  const trackingId = 'test-tracking-id';

  beforeEach(() => {
    mockFindFullById.mockResolvedValue({ repoSlug: 'MillionOnMars/lumina5' });
    mockGetSettingsValue.mockResolvedValue({ repos: [] });
  });

  it('empty approverIds → anyone can approve', async () => {
    mockResolveFullConfig.mockReturnValue({ slack: { approverIds: '' } });

    const result = await handleSreApprovalAction('sre_approve_fix', trackingId, { id: 'U_RANDOM' });

    // Auth passed - response may be undefined text (downstream error) but NOT the unauthorized message
    expect(String(result.response.text ?? '')).not.toContain(':no_entry:');
  });

  it('configured approverIds → authorized user proceeds', async () => {
    mockResolveFullConfig.mockReturnValue({ slack: { approverIds: 'U01,U02' } });

    const result = await handleSreApprovalAction('sre_approve_fix', trackingId, { id: 'U01' });

    expect(String(result.response.text ?? '')).not.toContain(':no_entry:');
  });

  it('configured approverIds → unauthorized user rejected', async () => {
    mockResolveFullConfig.mockReturnValue({ slack: { approverIds: 'U01,U02' } });

    const result = await handleSreApprovalAction('sre_approve_fix', trackingId, { id: 'U99' });

    expect(result.response.text).toContain(':no_entry:');
  });
});

describe('postSreAnalysisFailureMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('posts blocks with failure reason and fingerprint', async () => {
    await postSreAnalysisFailureMessage(
      'tracking-1',
      'fp-abc123',
      'TypeError: Cannot read property',
      'Circuit breaker open (5 consecutive failures)',
      'https://github.com/org/repo/issues/42',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blockText = JSON.stringify(mockPostMessage.mock.calls[0][0].blocks);
    expect(blockText).toContain('Circuit breaker open');
    expect(blockText).toContain('fp-abc123'.slice(0, 12));
  });

  it('strips newlines from sourceRef URL', async () => {
    await postSreAnalysisFailureMessage(
      'tracking-1',
      'fp-abc123',
      'TypeError: bad',
      'GitHub unavailable',
      'https://github.com/org/repo/issues/42\nX-Injected-Header: value',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{ type: string; text?: { text: string } }>;
    const sourceBlock = blocks.find(b => b.type === 'section' && b.text?.text.includes('*Source:*'));
    // Newline stripped from the sourceRef URL in the Source block
    expect(sourceBlock?.text?.text).not.toMatch(/\n/);
  });

  it('wraps non-URL sourceRef in backticks', async () => {
    await postSreAnalysisFailureMessage(
      'tracking-1',
      'fp-abc123',
      '',
      'Circuit breaker open',
      '/aws/lambda/my-function',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{ type: string; text?: { text: string } }>;
    const sourceBlock = blocks.find(b => b.type === 'section' && b.text?.text.includes('*Source:*'));
    expect(sourceBlock?.text?.text).toContain('`/aws/lambda/my-function`');
  });

  it('includes custom phaseLabel in header', async () => {
    await postSreAnalysisFailureMessage(
      'tracking-1',
      'fp-abc123',
      '',
      'Circuit breaker open',
      'https://github.com/org/repo/issues/1',
      { workspaceId: 'ws-1', channelId: 'C123' },
      'Revision'
    );

    const blockText = JSON.stringify(mockPostMessage.mock.calls[0][0].blocks);
    expect(blockText).toContain('Revision Failed');
  });
});

describe('postSreLowConfidenceMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('posts blocks with confidence and threshold', async () => {
    await postSreLowConfidenceMessage(
      'tracking-1',
      { rootCause: 'Null pointer in auth middleware', confidence: 45 },
      'TypeError: Cannot read property of null',
      'fp-def456',
      { askThreshold: 60 },
      'https://github.com/org/repo/issues/99',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blockText = JSON.stringify(mockPostMessage.mock.calls[0][0].blocks);
    expect(blockText).toContain('45%');
    expect(blockText).toContain('60%');
    expect(blockText).toContain('Null pointer in auth middleware');
  });
});

describe('postSreRateLimitedMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('posts blocks with rate info', async () => {
    await postSreRateLimitedMessage(
      'tracking-1',
      { rootCause: 'Missing null check in query builder', confidence: 82 },
      'ReferenceError: query is not defined',
      'fp-ghi789',
      { fixesToday: 5, maxFixesPerDay: 5 },
      'https://github.com/org/repo/issues/101',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blockText = JSON.stringify(mockPostMessage.mock.calls[0][0].blocks);
    expect(blockText).toContain('5/5');
    expect(blockText).toContain('Missing null check in query builder');
  });
});

describe('postSreFixLoopMessage — block building', () => {
  beforeEach(() => {
    mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-test', _id: 'ws-1' });
    mockPostMessage.mockClear();
  });

  it('omits actions block when githubIssueNumber is undefined', async () => {
    await postSreFixLoopMessage(
      'tracking-1',
      'TypeError: Cannot read property',
      'fp-abc123',
      undefined,
      'MillionOnMars/lumina5',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{ type: string }>;
    expect(blocks.some(b => b.type === 'actions')).toBe(false);
  });

  it('includes actions block with GitHub Issue button when githubIssueNumber is set', async () => {
    await postSreFixLoopMessage(
      'tracking-1',
      'TypeError: Cannot read property',
      'fp-abc123',
      777,
      'MillionOnMars/lumina5',
      { workspaceId: 'ws-1', channelId: 'C123' }
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const blocks = mockPostMessage.mock.calls[0][0].blocks as Array<{
      type: string;
      elements?: Array<{ url?: string }>;
    }>;
    const actionsBlock = blocks.find(b => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock?.elements?.[0]?.url).toContain('/issues/777');
  });
});
