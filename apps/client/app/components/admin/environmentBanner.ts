/**
 * Resolve the admin environment banner's color + label from the current hostname.
 *
 * Pure and hostname-driven (the production domain is passed in from
 * NEXT_PUBLIC_SERVER_DOMAIN) so it can be unit-tested without rendering AdminPage.
 *
 * Order matters: localhost -> staging -> preview -> production -> unknown.
 * Preview MUST be checked before production: PR-preview deployments are served at
 * `app.pr<N>.preview.<domain>` where NEXT_PUBLIC_SERVER_DOMAIN is the per-PR
 * `pr<N>.preview.<domain>`, so the host would otherwise exactly match `app.<domain>`
 * and be mislabeled "Production". Staging is excluded the same way via its substring.
 */
export interface EnvironmentBannerInfo {
  bannerColor: string;
  environmentName: string;
}

export function resolveEnvironmentBanner(hostname: string, serverDomain: string | undefined): EnvironmentBannerInfo {
  if (hostname === 'localhost' || hostname.includes('localhost:')) {
    return { bannerColor: 'green', environmentName: 'Local Development' };
  }
  if (hostname.includes('staging')) {
    return { bannerColor: 'blue', environmentName: 'Staging Environment' };
  }
  // Anchor on `.preview.` (not a bare `preview` substring) so a production vanity domain
  // that merely contains "preview" (e.g. `app.previewco.com`) isn't mislabeled Preview.
  // PR-preview hosts are always `app.pr<N>.preview.<domain>`, so `.preview.` is reliable.
  if (hostname.includes('.preview.')) {
    return { bannerColor: 'purple', environmentName: 'Preview Environment' };
  }
  // Production host derived from the account-tied deployment domain - no hardcoded brand
  // hosts. Staging and preview are handled above, so an exact `app.<domain>` match here
  // is production.
  if (!!serverDomain && hostname === `app.${serverDomain}`) {
    return { bannerColor: 'red', environmentName: 'Production Environment' };
  }
  return { bannerColor: '#d3d32d', environmentName: 'Unknown Environment' };
}
