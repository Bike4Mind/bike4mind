import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository } from '@bike4mind/database';
import {
  BadRequestError,
  deriveTagPrefixFromLakeName,
  ForbiddenError,
  isValidDataLakeSlug,
  MIN_DATA_LAKE_SLUG_LENGTH,
  submittedTagPrefix,
  tagPrefixIssue,
} from '@bike4mind/common';
import { Request } from 'express';
import { resolveActiveOrg } from '@server/utils/resolveActiveOrg';

// GET /api/data-lakes/slug-preview?name=&organizationId=&tagPrefix= - the slug a create with this
// name would get right now (the wizard's Config step), and the first free tag prefix starting from
// `tagPrefix` (else the name-derived default), or null when that base is unusable - the form's own
// tagPrefixIssue reports why. Session-only and internal. `slug` says whether a slug is taken in the
// caller's validated scope. In personal scope that namespace is shared by every user's org-less
// lakes (the unique datalakeTag), so this does tell a caller that SOME org-less lake holds a slug -
// never which lake or whose. Create discloses the same through its "-N" suffix, only with the side
// effect of making a lake. `tagPrefix` likewise says that some lake in the caller's prefix scope
// (their own, or their org's) holds a prefix, never which one - the same thing create's
// TAG_PREFIX_UNAVAILABLE error reveals.
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    if (req.apiKeyInfo) throw new ForbiddenError('API keys cannot preview data lake slugs');
    const { name, organizationId, tagPrefix } = req.query;
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestError('name is required');
    // Create's schema refuses such a slug, so a preview of it would promise a lake that cannot exist.
    if (!isValidDataLakeSlug(name)) {
      throw new BadRequestError(`name must contain at least ${MIN_DATA_LAKE_SLUG_LENGTH} letters or digits`);
    }
    if (organizationId !== undefined && typeof organizationId !== 'string') {
      throw new BadRequestError('organizationId must be a single string');
    }
    if (tagPrefix !== undefined && typeof tagPrefix !== 'string') {
      throw new BadRequestError('tagPrefix must be a single string');
    }
    // Same org resolution as POST /api/data-lakes, so the preview checks the scope create will use.
    const orgId = await resolveActiveOrg(req, organizationId);
    const slug = await dataLakeService.previewDataLakeSlug({ dataLakes: dataLakeRepository }, name, orgId);
    const basePrefix = tagPrefix !== undefined ? submittedTagPrefix(tagPrefix) : deriveTagPrefixFromLakeName(name);
    const previewPrefix =
      basePrefix && !tagPrefixIssue(basePrefix)
        ? await dataLakeService.previewDataLakeTagPrefix({ dataLakes: dataLakeRepository }, basePrefix, {
            createdByUserId: req.user.id,
            organizationId: orgId,
          })
        : null;
    return res.json({ slug, tagPrefix: previewPrefix });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
