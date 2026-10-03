import { DECISION_COOKIE, REGION_COOKIE } from '@client/lib/consentCookies';
import { CONSENT_KEY } from './consentRegion';

declare global {
  interface Window {
    /**
     * The analytics_storage state GA had when it recorded this page: set by the inline tag
     * before the landing page_view, and moved to 'granted' once a later grant has recorded
     * the page again (see CookieConsentBanner).
     */
    __b4mGaConsentDefault?: 'granted' | 'denied';
  }
}

/**
 * The inline GA tag for the root layout.
 *
 * gtag's `config` sends the landing page_view at once, and that hit is the one carrying the
 * referrer and campaign. If consent is still the blanket 'denied' default at that moment, the
 * hit goes cookieless; the grant the banner applies after hydration then starts GA's cookied
 * session on a later event with no source, and the visit is reported as "(not set)". So the
 * default is resolved here, synchronously and before `config`, from the same signals as
 * `resolveConsent()` in the same order: this origin's stored decision, then the marketing
 * site's, then the region. A test runs this script against every combination of them and
 * holds it to `resolveConsent()`, so the two cannot drift.
 *
 * Only 'granted' is granted: 'unset' (in the opt-in region, not asked yet) stays denied
 * until the visitor answers.
 */
export function gaBootstrapScript(measurementId: string, cookieDomain?: string): string {
  const config = cookieDomain ? `, ${JSON.stringify({ cookie_domain: cookieDomain })}` : '';
  return `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.__b4mGaConsentDefault = (function () {
  function cookie(name) {
    var parts = document.cookie.split('; ');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(name + '=') === 0) return parts[i].slice(name.length + 1);
    }
    return undefined;
  }
  var decision = null;
  try {
    var stored = localStorage.getItem(${JSON.stringify(CONSENT_KEY)});
    if (stored === 'granted' || stored === 'denied') decision = stored;
  } catch (e) {}
  if (decision === null) {
    var shared = cookie(${JSON.stringify(DECISION_COOKIE)});
    if (shared === 'granted' || shared === 'denied') decision = shared;
  }
  if (decision !== null) return decision;
  return cookie(${JSON.stringify(REGION_COOKIE)}) === 'row' ? 'granted' : 'denied';
})();
gtag('consent', 'default', { analytics_storage: window.__b4mGaConsentDefault });
gtag('js', new Date());
gtag('config', ${JSON.stringify(measurementId)}${config});
`;
}
