import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { FilterQuery } from 'mongoose';
import { IModalDocument } from '@bike4mind/common';
import { extractVariantForViewer, viewerClassifier } from '@bike4mind/services';

const WHATS_NEW_TAG = 'whats-new';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.ability) throw new ForbiddenError('Ability not found');
    if (!req.ability.can('read', ModalModel)) throw new ForbiddenError('Permission denied');

    const query = req.query as { tags?: string; excludeWhatsNew?: string };
    const { tags, excludeWhatsNew } = query;

    const filter: FilterQuery<IModalDocument> = {};

    // Filter by tags if provided (for What's New modals tab)
    if (typeof tags === 'string') {
      filter.tags = tags;
    }

    // Exclude What's New modals from general modals list (default behavior for admin)
    // Unless specifically requesting What's New modals via tags query or excludeWhatsNew=false
    if (excludeWhatsNew === 'true' || (!tags && req.user?.isAdmin && excludeWhatsNew !== 'false')) {
      filter.tags = { $ne: WHATS_NEW_TAG };
    }

    const modals = await ModalModel.find(filter);

    // Resolve the viewer's audience key server-side from their stored tags.
    // Fail-open to the safe default (customer) on any error - a database blip
    // or malformed context degrades to customer content, never a 500.
    let audienceKey: string;
    try {
      audienceKey = await viewerClassifier.classify({
        isAdmin: req.user?.isAdmin ?? false,
      } as never);
    } catch (error) {
      audienceKey = viewerClassifier.safeDefaultKey;
      // Fail-open must be observable: a silently-failing classifier looks
      // identical to a healthy one (every internal viewer quietly downgraded to
      // customer). Surface it so a sustained rate is detectable. The classifier
      // is a synchronous in-memory tag check, so this should effectively never
      // fire; wire a counter/alert here if it ever becomes I/O-bound.
      console.warn('[modals] viewer classification failed; fell back to safe default', {
        safeDefaultKey: audienceKey,
        userId: req.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Apply the leak guard to every document. This strips variants and
    // generationMetadata, flattens the viewer's variant fields to top level,
    // and drops documents with no content for this audience key.
    // Applied to every viewer including admins - never bypassed.
    const served = modals
      .map(doc => extractVariantForViewer(doc.toObject(), audienceKey))
      .filter((doc): doc is NonNullable<typeof doc> => doc !== null);

    // Prevent caching to ensure users always get fresh modal data
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.json(served);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
