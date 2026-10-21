import * as cheerio from 'cheerio';

export function isIssuedTrackingLink(html: string, token: string, target: string): boolean {
  const $ = cheerio.load(html);
  return $('a[href]')
    .toArray()
    .some(element => {
      try {
        const link = new URL($(element).attr('href') ?? '');
        return (
          link.pathname === `/api/email/track/click/${encodeURIComponent(token)}` &&
          link.searchParams.get('url') === target
        );
      } catch {
        return false;
      }
    });
}
