import { extractHTMLTitle } from '@bike4mind/utils/artifactParser';

/** The trimmed <title> of an HTML error page, or null when it has none or it is just "Error". */
export function htmlErrorTitle(html: string): string | null {
  const title = extractHTMLTitle(html);
  return title !== null && title !== 'Error' ? title.trim() : null;
}
