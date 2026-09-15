import * as cheerio from 'cheerio';

export const getLinksFromHtml = (html: string): string[] => {
  const $ = cheerio.load(html);

  const links: string[] = [];

  const extractLink = (value: string) => {
    if (value.includes('view.officeapps.live.com')) {
      const src = new URL(value);
      const srcPath = src.searchParams.get('src');
      if (srcPath) {
        return srcPath;
      }

      return value;
    } else {
      return value;
    }
  };

  $('a')
    .not($('header a, footer a, nav a'))
    .map((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        // handle office documents
        // e.g https://view.officeapps.live.com/op/view.aspx?src=https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/SlidesFY25Q3
        links.push(extractLink(href));
      }
    });

  $('li')
    .not($('header li, footer li, nav li'))
    .map((_, element) => {
      const link = $(element).attr('link');
      if (link) {
        links.push(extractLink(link));
      }
    });

  return links;
};
