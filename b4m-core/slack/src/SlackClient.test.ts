import { describe, it, expect, vi } from 'vitest';
import { SlackClient, escapeSlackMrkdwn } from './SlackClient';

vi.mock('./di/registry', () => ({
  getSlackDeps: () => ({ integrationCircuitBreaker: { isAvailable: vi.fn().mockResolvedValue(true) } }),
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

describe('SlackClient.sendMessage', () => {
  it('posts without link or media unfurling', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
    WebClientCtor.mockImplementationOnce(function () {
      return { chat: { postMessage }, on: vi.fn() };
    });

    await new SlackClient('xoxb-test-token', logger).sendMessage({ channel: 'C1', text: 'see https://x.example' });

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ unfurl_links: false, unfurl_media: false }));
  });
});

describe('SlackClient expected workspace errors', () => {
  const platformError = (code: string) =>
    Object.assign(new Error(`An API error occurred: ${code}`), {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: code },
    });

  const clientWith = (failure: Error) => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    WebClientCtor.mockImplementationOnce(function () {
      return {
        chat: { postMessage: vi.fn().mockRejectedValue(failure) },
        conversations: { history: vi.fn().mockRejectedValue(failure) },
        on: vi.fn(),
      };
    });
    return { client: new SlackClient('xoxb-test-token', log as never), log };
  };

  it('sendMessage logs not_in_channel at warn with the method and code, and returns null', async () => {
    const { client, log } = clientWith(platformError('not_in_channel'));

    await expect(client.sendMessage({ channel: 'C1', text: 'hi' })).resolves.toBeNull();

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not_in_channel'), {
      method: 'sendMessage',
      slackErrorCode: 'not_in_channel',
    });
  });

  it('fetchChannelHistory logs channel_not_found at warn and returns no messages', async () => {
    const { client, log } = clientWith(platformError('channel_not_found'));

    await expect(client.fetchChannelHistory('C1')).resolves.toEqual([]);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('channel_not_found'), {
      method: 'fetchChannelHistory',
      slackErrorCode: 'channel_not_found',
    });
  });

  it.each([
    ['an unknown platform error', platformError('internal_error')],
    ['an HTTP 5xx error', Object.assign(new Error('HTTP 503'), { code: 'slack_webapi_http_error' })],
  ])('keeps %s at error for both methods', async (_label, failure) => {
    const send = clientWith(failure);
    await send.client.sendMessage({ channel: 'C1', text: 'hi' });
    expect(send.log.error).toHaveBeenCalledWith('Error sending Slack message:', failure);

    const history = clientWith(failure);
    await history.client.fetchChannelHistory('C1');
    expect(history.log.error).toHaveBeenCalledWith('Error fetching Slack channel history:', failure);
    expect(history.log.warn).not.toHaveBeenCalled();
  });
});
