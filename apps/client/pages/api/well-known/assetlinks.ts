/**
 * GET /api/well-known/assetlinks
 *
 * Digital Asset Links statement that lets Android verify the app's https sign-in redirect
 * (/android/auth-callback, client b4m-android-app) as an App Link. Mapped from
 * /.well-known/assetlinks.json via next.config.mjs rewrites. The signing-cert fingerprints come
 * from the androidAppCertFingerprints admin setting; while it is empty the statement list is empty,
 * so no app is verified.
 */
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

// Must match applicationId in apps/android.
export const ANDROID_APP_PACKAGE_NAME = 'com.bike4mind.app';

const handler = baseApi({ auth: false }).get(async (_req, res) => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['androidAppCertFingerprints'] }
  );
  const fingerprints = getSettingsValue('androidAppCertFingerprints', settings, []);

  // Short max-age: Android re-fetches on install/update, and a rotated cert should land quickly.
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (fingerprints.length === 0) return res.json([]);
  return res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_APP_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

export const config = { api: { externalResolver: true } };
export default handler;
