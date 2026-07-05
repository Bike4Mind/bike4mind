import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import mime from 'mime-types';
import { validateUrlForFetch } from './ssrfProtection';

// Centralized URL regex - handles ports, query params, fragments
export const URL_REGEX =
  /https?:\/\/(?:[-\w.])+(?:\:[0-9]+)?(?:\/(?:[\w\/_.])*(?:\?(?:[\w&=%.])*)?(?:\#(?:[\w.])*)?)?/gi;

export function detectURLs(string: string): string[] {
  const urlsFound = string.match(URL_REGEX) || [];
  return urlsFound;
}

// Check if a string contains any URLs
export function hasURLs(string: string): boolean {
  return URL_REGEX.test(string);
}

// Check if a string contains URLs and return them
export function urlExists(stringWithPossibleUrl: string): string[] {
  const cleanString = stringWithPossibleUrl.replace(/\n/g, ' ').replace(/,/g, ' ');
  return detectURLs(cleanString);
}

interface ParsedContent {
  title: string;
  textContent: Buffer | string;
  mimeType: string;
  ext: string | null;
}

// Default timeout for URL fetching (10 seconds)
const URL_FETCH_TIMEOUT_MS = 10_000;

// Fetch and parse HTML content from a URL; returns the page title and text.
export async function fetchAndParseURL(url: string, { logger }: { logger: Logger }): Promise<ParsedContent> {
  logger.updateMetadata({ failedUrl: null });
  try {
    // SECURITY: Validate URL to prevent SSRF attacks.
    // This blocks requests to internal networks, cloud metadata endpoints, etc.
    const ssrfValidation = await validateUrlForFetch(url);
    if (!ssrfValidation.valid) {
      throw new Error(`URL blocked for security reasons: ${ssrfValidation.error}`);
    }

    let urlMimeType = 'text/plain';

    if (url.split('.')?.pop()?.startsWith('pdf')) {
      urlMimeType = 'application/pdf';
    }

    const response = await axios.get(url, {
      responseType: ['application/pdf'].includes(urlMimeType) ? 'arraybuffer' : 'text',
      timeout: URL_FETCH_TIMEOUT_MS, // Prevent Lambda timeout exhaustion
    });
    const cheerio = await import('cheerio');
    const htmlContent = response.data;
    const $ = cheerio.load(htmlContent);
    const title = $('title').text() || (url.split('/')?.pop() as string);
    let urlContent = null;

    switch (urlMimeType) {
      case 'application/pdf': {
        const pdfbuffer = Buffer.from(response.data);
        urlContent = pdfbuffer;
        break;
      }
      default: {
        let textContent = '';
        $('body')
          .find('p')
          .each((index, element) => {
            textContent += $(element).text() + '\n';
          });
        urlContent = textContent || htmlContent;
        break;
      }
    }

    logger.log(`Fetched ${title} with mimetype ${urlMimeType} and parsed ${url}`);
    return { title, textContent: urlContent, mimeType: urlMimeType, ext: mime.extension(urlMimeType) || null };
  } catch (error) {
    logger.updateMetadata({ failedUrl: url });
    logger.debug('Error fetching or parsing URL:', error);
    throw error;
  }
}
