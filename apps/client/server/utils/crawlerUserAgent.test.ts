import { describe, expect, it } from 'vitest';
import { isCrawlerUserAgent } from './crawlerUserAgent';

describe('isCrawlerUserAgent', () => {
  it.each([
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1)',
    'Mozilla/5.0 (compatible; Mastodon/4.2)',
  ])('flags %s', ua => {
    expect(isCrawlerUserAgent(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.90.0.38 (iPhone14,2; iOS 17.5; gzip)',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Viber/21.0.0',
    undefined,
  ])('does not flag %s', ua => {
    expect(isCrawlerUserAgent(ua)).toBe(false);
  });
});
