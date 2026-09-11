import { describe, it, expect, vi } from 'vitest';
import { SlackClient, escapeSlackMrkdwn } from './SlackClient';

vi.mock('./di/registry', () => ({
  getSlackDeps: () => ({ integrationCircuitBreaker: { isAvailable: vi.fn() } }),
  getSlackDb: () => ({}),
}));

const { WebClientCtor } = vi.hoisted(() => ({
  WebClientCtor: vi.fn().mockImplementation(function () {
    return { chat: { postMessage: vi.fn() }, on: vi.fn() };
  }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: WebClientCtor,
  WebClientEvent: { RATE_LIMITED: 'rate_limited' },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('escapeSlackMrkdwn', () => {
  it('escapes the characters Slack mrkdwn special-forms rely on, so <!channel> cannot broadcast', () => {
    expect(escapeSlackMrkdwn('<!channel> URGENT')).toBe('&lt;!channel&gt; URGENT');
  });

  it('escapes a user mention the same way, so <@U123> cannot ping', () => {
    expect(escapeSlackMrkdwn('<@U12345>')).toBe('&lt;@U12345&gt;');
  });

  it('escapes a literal ampersand so it is not read as the start of an entity', () => {
    expect(escapeSlackMrkdwn('Q&A.pdf')).toBe('Q&amp;A.pdf');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeSlackMrkdwn('Quarterly Report.pdf')).toBe('Quarterly Report.pdf');
  });
});

describe('SlackClient constructor', () => {
  it('sets no request timeout by default - unlimited, matching every pre-existing caller', () => {
    // The timeout is opt-in per instance, not global to the class: ~30 call sites share
    // SlackClient, most of which never asked for a ceiling and might legitimately need longer
    // than a fixed default (e.g. a paginated Slack-export conversations.history call).
    new SlackClient('xoxb-test-token', logger);

    expect(WebClientCtor).toHaveBeenCalledWith('xoxb-test-token', expect.objectContaining({ timeout: undefined }));
  });

  it('sets a request timeout on the underlying WebClient when a caller opts in via options.timeoutMs', () => {
    // Used by notifySlackIndexingComplete.ts, the one caller posting inline from a
    // time-budgeted Lambda, so a slow (not down) Slack API cannot block it indefinitely.
    new SlackClient('xoxb-test-token', logger, { timeoutMs: 10_000 });

    expect(WebClientCtor).toHaveBeenCalledWith('xoxb-test-token', expect.objectContaining({ timeout: 10_000 }));
  });
});
