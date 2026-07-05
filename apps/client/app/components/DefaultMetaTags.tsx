import { useEffect } from 'react';
import useGetLogo from '../hooks/useGetLogo';
import { useBrandingSettings } from '../hooks/data/settings';
import { APP_NAME } from '@client/config/general';

const DefaultMetaTags = () => {
  const defaultTitle = APP_NAME;
  // TODO: Add App description
  const defaultDescription = '';
  const logoUrl = useGetLogo();
  const { data: { tagLineMain } = {} } = useBrandingSettings();

  // Set the default document.title and og:title exactly once on mount. After
  // that, per-page `useDocumentTitle` calls own them; re-running when async
  // branding deps resolve would clobber the active page's title.

  useEffect(() => {
    // APP_NAME may be empty when the operator hasn't configured a brand (open-core).
    // Skip setting an empty title so the document keeps its static index.html title instead
    // of being blanked out.
    const title = tagLineMain || defaultTitle;
    if (!title) return;
    document.title = title;
    let ogTitle = document.querySelector('meta[property="og:title"]') as HTMLMetaElement;
    if (!ogTitle) {
      ogTitle = document.createElement('meta');
      ogTitle.setAttribute('property', 'og:title');
      document.head.appendChild(ogTitle);
    }
    ogTitle.content = title;
  }, []);

  useEffect(() => {
    const setMetaTag = (name: string, content: string, property = false) => {
      const attribute = property ? 'property' : 'name';
      let meta = document.querySelector(`meta[${attribute}="${name}"]`) as HTMLMetaElement;
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute(attribute, name);
        document.head.appendChild(meta);
      }
      meta.content = content;
    };

    if (!document.querySelector('meta[name="viewport"]')) {
      const viewport = document.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'minimum-scale=1, initial-scale=1, width=device-width';
      document.head.appendChild(viewport);
    }

    const favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    if (favicon && logoUrl) {
      favicon.href = logoUrl;
    } else if (!favicon) {
      const newFavicon = document.createElement('link');
      newFavicon.rel = 'icon';
      newFavicon.href = logoUrl || '/favicon.ico';
      document.head.appendChild(newFavicon);
    }

    if (APP_NAME) {
      setMetaTag('application-name', APP_NAME);
      setMetaTag('mobile-web-app-title', APP_NAME);
    }
    setMetaTag('description', defaultDescription);
    setMetaTag('mobile-web-app-capable', 'yes');
    // og:title intentionally NOT set here - per-page useDocumentTitle owns it
    // alongside document.title to keep them in sync.
    setMetaTag('og:description', defaultDescription, true);
  }, [defaultDescription, logoUrl]);

  return null;
};

export default DefaultMetaTags;
