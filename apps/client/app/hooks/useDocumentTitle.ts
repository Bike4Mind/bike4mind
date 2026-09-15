import { useEffect } from 'react';

/**
 * Update the document title and og:title meta tag. Replaces `next/head`,
 * which does not work with TanStack Router.
 *
 * @example
 * useDocumentTitle('Agent Details', ' | My App');
 *
 * @param title - The title to set. If undefined, title won't be updated
 * @param suffix - Optional suffix to append to the title (e.g., " - My App")
 */
export function useDocumentTitle(title?: string, suffix?: string) {
  useEffect(() => {
    if (title) {
      const fullTitle = suffix ? `${title}${suffix}` : title;
      document.title = fullTitle;

      let ogTitle = document.querySelector('meta[property="og:title"]') as HTMLMetaElement;
      if (!ogTitle) {
        ogTitle = document.createElement('meta');
        ogTitle.setAttribute('property', 'og:title');
        document.head.appendChild(ogTitle);
      }
      ogTitle.content = fullTitle;
    }
  }, [title, suffix]);
}
