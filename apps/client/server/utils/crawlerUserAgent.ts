/**
 * Link-preview, search and indexing crawlers fetch every pasted URL
 * automatically, so their fetches must not count as someone viewing a page.
 * Matches fetcher-specific tokens plus a generic bot/crawler/spider tail for
 * the long tail of unfurlers. App-name tokens are left out on purpose: in-app
 * browsers send them on real human page loads.
 */
const CRAWLER_UA_RE =
  /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|iframely|embedly|redditbot|pinterestbot|googlebot|google-pagerenderer|bingbot|applebot|duckduckbot|yandex|baiduspider|petalbot|mastodon|cardyb|bluesky|vkshare|bot\b|crawler|spider|preview/i;

export function isCrawlerUserAgent(userAgent: string | undefined): boolean {
  return !!userAgent && CRAWLER_UA_RE.test(userAgent);
}
