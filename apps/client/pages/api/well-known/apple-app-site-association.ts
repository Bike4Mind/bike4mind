/**
 * GET /api/well-known/apple-app-site-association
 *
 * Apple app site association that lets the iOS app complete its https sign-in callback
 * (/ios/auth-callback via ASWebAuthenticationSession, which needs `webcredentials`) and open
 * universal links. Mapped from /.well-known/apple-app-site-association via next.config.mjs rewrites.
 * The app id is built from the iosAppTeamId admin setting; while it is empty no app is listed.
 * Served on every stage, but only the production host is in the app's associated-domains entitlement.
 */
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

// Must match PRODUCT_BUNDLE_IDENTIFIER of the app target in apps/ios.
export const IOS_APP_BUNDLE_ID = 'com.bike4mind.app';

// Must stay in sync with DeepLinkRouter in apps/ios and the iOS OAuth client's redirect URI.
export const IOS_UNIVERSAL_LINK_PATHS = ['/ios/auth-callback', '/sessions/*', '/notebooks/*'] as const;

type AppSiteAssociation = {
  applinks: { details: { appIDs: string[]; components: { '/': string }[] }[] };
  webcredentials: { apps: string[] };
};

export function buildAppSiteAssociation(teamId: string): AppSiteAssociation {
  if (!teamId) return { applinks: { details: [] }, webcredentials: { apps: [] } };
  const appId = `${teamId}.${IOS_APP_BUNDLE_ID}`;
  return {
    applinks: {
      details: [{ appIDs: [appId], components: IOS_UNIVERSAL_LINK_PATHS.map(path => ({ '/': path })) }],
    },
    webcredentials: { apps: [appId] },
  };
}

const handler = baseApi({ auth: false }).get(async (_req, res) => {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['iosAppTeamId'] });
  const teamId = getSettingsValue('iosAppTeamId', settings, '');

  // Apple's CDN fetches this, not the device; a short max-age keeps a newly set team id from lagging.
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json(buildAppSiteAssociation(teamId));
});

export const config = { api: { externalResolver: true } };
export default handler;
