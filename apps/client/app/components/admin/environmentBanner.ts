import type { DeploymentEnvironment } from '@client/app/utils/themes/admin';

/**
 * Resolve the admin environment banner's environment + label from the current hostname.
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
  /** Keys the banner fill in `environmentBannerPalette`. */
  environment: DeploymentEnvironment;
  environmentName: string;
}

/** The sidebar's short environment chip; production has none. */
export const environmentChipLabel: Record<DeploymentEnvironment, string | null> = {
  local: 'Local',
  staging: 'Staging',
  preview: 'Preview',
  production: null,
  unknown: 'Unknown',
};

export function resolveEnvironmentBanner(hostname: string, serverDomain: string | undefined): EnvironmentBannerInfo {
  if (hostname === 'localhost' || hostname.includes('localhost:')) {
    return { environment: 'local', environmentName: 'Local Development' };
  }
  if (hostname.includes('staging')) {
    return { environment: 'staging', environmentName: 'Staging Environment' };
  }
  // Anchor on `.preview.` (not a bare `preview` substring) so a production vanity domain
  // that merely contains "preview" (e.g. `app.previewco.com`) isn't mislabeled Preview.
  // PR-preview hosts are always `app.pr<N>.preview.<domain>`, so `.preview.` is reliable.
  if (hostname.includes('.preview.')) {
    return { environment: 'preview', environmentName: 'Preview Environment' };
  }
  // Production host derived from the account-tied deployment domain - no hardcoded brand
  // hosts. Staging and preview are handled above, so an exact `app.<domain>` match here
  // is production.
  if (!!serverDomain && hostname === `app.${serverDomain}`) {
    return { environment: 'production', environmentName: 'Production Environment' };
  }
  return { environment: 'unknown', environmentName: 'Unknown Environment' };
}

export const resolveCurrentEnvironment = () =>
  resolveEnvironmentBanner(
    typeof window !== 'undefined' ? window.location.hostname : '',
    process.env.NEXT_PUBLIC_SERVER_DOMAIN
  );
