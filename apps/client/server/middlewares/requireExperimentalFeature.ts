import { isExperimentalFeatureEnabled } from '@bike4mind/common';
import { RequestHandler } from 'express';

/**
 * Server-side gate for a USER-only experimental flag - one with no admin
 * `SettingKey` behind it (the `{}` entries in `useFeatureEnabled`, e.g.
 * `enableQuestMasterV5`, `enableMementosV2`).
 *
 * `requireFeatureEnabled` cannot express these: it resolves the flag through
 * `settingsMap`, so a flag with no key there reads as permanently disabled and
 * the route would 403 for everyone. This gate reads the per-user opt-in
 * instead, via the one sanctioned reader (the bag is a Mongoose Map on a
 * hydrated doc - see `isExperimentalFeatureEnabled`).
 *
 * Mount AFTER `requireUser`: the opt-in lives on the user document, so an
 * unauthenticated request has nothing to read and fails closed.
 */
export const requireExperimentalFeature =
  (flag: string): RequestHandler =>
  (req, res, next) => {
    if (!isExperimentalFeatureEnabled(req.user, flag)) {
      return res.status(403).json({
        error: 'Feature not available',
        code: 'FEATURE_DISABLED',
        request_id: req.requestId,
      });
    }
    next();
  };
