import { DECISION_COOKIE, REGION_COOKIE } from '@bike4mind/server-utils/lib/consentCookies';
import { CONSENT_KEY } from './consentRegion';

// Window.__b4mGaConsentDefault is declared in types/gaConsent.d.ts, not here: this module
// isn't imported by every file that reads/writes the global (see CookieConsentBanner), so the
// augmentation needs to be ambient rather than tied to this module's own compilation.

/** A deploy value as an id: surrounding whitespace dropped, empty read as unset. */
function envId(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The GA4 id, or undefined when this build has no GA. Gates both the gtag tag in app/layout.tsx
 * and the consent banner naming Google Analytics (utils/consentVendors.ts). */
export function getGaMeasurementId(): string | undefined {
  return envId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
}

/**
 * Every GA4 property this build reports to: the app's own first, then the marketing site's when
 * one is set. Empty when GA is off.
 *
 * The second property exists because a visitor's journey crosses two hosts: the ad click lands on
 * the marketing site, and sign_up and purchase happen here. GA4 reports a journey only within one
 * property, and two properties cannot be joined after the fact, so the app also sends to the
 * marketing site's property. That property then holds the whole funnel, while the app's own keeps
 * its history unbroken. The two hosts already share the `_ga` client id through the apex cookie,
 * so the visitor and their session carry across.
 *
 * GA_MEASUREMENT_ID stays the one switch: the marketing id only ever rides alongside it.
 */
export function getGaMeasurementIds(): string[] {
  const primary = getGaMeasurementId();
  if (!primary) return [];
  const marketing = envId(process.env.NEXT_PUBLIC_GA_MARKETING_MEASUREMENT_ID);
  return marketing && marketing !== primary ? [primary, marketing] : [primary];
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
 *
 * One `config` per property (getGaMeasurementIds), all after the consent default and all with the
 * same cookie domain, so every property reads the one `_ga` client id. Events sent without a
 * `send_to` reach every configured property, so sign_up and purchase go to each.
 *
 * `page_location` is set to the URL without its fragment before `config`, and re-set on every
 * history change (which is what GA's own SPA page_views follow), because some pages carry a
 * token in the fragment (sign-in callbacks, share links) that must never reach a GA hit.
 */
export function gaBootstrapScript(measurementIds: readonly string[], cookieDomain?: string): string {
  const config = cookieDomain ? `, ${JSON.stringify({ cookie_domain: cookieDomain })}` : '';
  const configs = measurementIds.map(id => `gtag('config', ${JSON.stringify(id)}${config});`).join('\n');
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
(function () {
  function setPageLocation() {
    var l = window.location;
    gtag('set', { page_location: l.origin + l.pathname + l.search });
  }
  setPageLocation();
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    history[method] = function () {
      var result = original.apply(this, arguments);
      setPageLocation();
      return result;
    };
  });
  window.addEventListener('popstate', setPageLocation);
  window.addEventListener('hashchange', setPageLocation);
})();
${configs}
`;
}
