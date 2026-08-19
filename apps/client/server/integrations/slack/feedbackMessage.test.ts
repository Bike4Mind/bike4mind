import { describe, it, expect } from 'vitest';
import { buildFeedbackSlackMessage, buildPromptMetaSummary } from './feedbackMessage';

describe('buildPromptMetaSummary', () => {
  it('summarizes a full promptMeta into a short, readable set of signals', () => {
    const summary = buildPromptMetaSummary({
      model: { name: 'claude-sonnet-5' },
      tokenUsage: { totalTokens: 1234, estimatedCost: 0.05 },
      finishReason: 'end_turn',
      functionCalls: [{ name: 'web_search' }, { name: 'search_knowledge_base' }],
      citables: [{}, {}],
      context: { lakeMemory: { beliefCount: 3, dataLakeTags: ['support-docs'] } },
    });
    expect(summary).toContain('Model: claude-sonnet-5');
    expect(summary).toContain('Tokens: 1234, est. cost $0.05');
    expect(summary).toContain('Finish reason: end_turn');
    expect(summary).toContain('Tool calls: 2 (web_search, search_knowledge_base), 2 citable(s)');
    expect(summary).toContain('Lake beliefs: 3 (support-docs)');
  });

  it('renders only the signals actually present', () => {
    const summary = buildPromptMetaSummary({ model: { name: 'claude-sonnet-5' } });
    expect(summary).toBe('Model: claude-sonnet-5');
  });

  it('returns "none" for an undefined promptMeta', () => {
    expect(buildPromptMetaSummary(undefined)).toBe('none');
  });

  it('returns "none" for an empty promptMeta object', () => {
    expect(buildPromptMetaSummary({})).toBe('none');
  });

  it('renders a zero token count and a zero belief count (not swallowed by a truthy check)', () => {
    const summary = buildPromptMetaSummary({
      tokenUsage: { totalTokens: 0 },
      context: { lakeMemory: { beliefCount: 0 } },
    });
    expect(summary).toContain('Tokens: 0');
    expect(summary).toContain('Lake beliefs: 0');
  });

  it('falls back to actualTotalTokens when totalTokens is absent', () => {
    const summary = buildPromptMetaSummary({ tokenUsage: { actualTotalTokens: 42 } });
    expect(summary).toContain('Tokens: 42');
  });

  it('escapes Slack mrkdwn special characters inside the summary itself (model name, tool names, lake tags)', () => {
    const injected = '<@here>';
    const summary = buildPromptMetaSummary({
      model: { name: injected },
      finishReason: injected,
      functionCalls: [{ name: injected }],
      context: { lakeMemory: { beliefCount: 1, dataLakeTags: [injected] } },
    });
    expect(summary).not.toContain('<@here>');
    expect(summary.match(/&lt;@here&gt;/g)).toHaveLength(4);
  });

  it('never surfaces owner-only function-call fields even if a caller failed to redact them', () => {
    const summary = buildPromptMetaSummary({
      functionCalls: [{ name: 'web_search' } as { name?: string; returnValue?: string }],
    });
    expect(summary).not.toContain('returnValue');
    expect(summary).not.toContain('parameters');
  });
});

describe('buildFeedbackSlackMessage', () => {
  const base = {
    stagePrefix: '',
    type: 'Bug',
    organization: 'Acme',
    username: 'jdoe',
    userEmail: 'jdoe@example.com',
    userId: 'user-1',
    content: 'it broke',
  };

  it('renders the label with an empty body for empty content', () => {
    const message = buildFeedbackSlackMessage({ ...base, content: '' });
    expect(message).toContain('*Feedback:* \n');
  });

  it('escapes an injection-shaped content value instead of letting it render as a live link', () => {
    const message = buildFeedbackSlackMessage({ ...base, content: '<https://evil.example/|Open record>' });
    expect(message).not.toContain('<https://evil.example/|Open record>');
    expect(message).toContain('&lt;https://evil.example/|Open record&gt;');
  });

  it('escapes username, userEmail, type, organization, and userId the same way as content', () => {
    const injected = '<@here>';
    const message = buildFeedbackSlackMessage({
      stagePrefix: '',
      type: injected,
      organization: injected,
      username: injected,
      userEmail: injected,
      userId: injected,
      content: injected,
    });
    expect(message).not.toContain('<@here>');
    expect(message.match(/&lt;@here&gt;/g)).toHaveLength(6);
  });

  it('includes the stage prefix ahead of the type line, unaffected by the promptMeta summary', () => {
    const message = buildFeedbackSlackMessage({ ...base, stagePrefix: '*[pr-1234]*\n', promptMeta: undefined });
    expect(message.startsWith('*[pr-1234]*\n*Type:*')).toBe(true);
    expect(message.split('*Prompt Meta:*')[1]).not.toContain('[pr-1234]');
  });
});
