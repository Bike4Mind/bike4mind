import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository } from '@bike4mind/database';
import { BadRequestError, ForbiddenError, isValidDataLakeSlug, MIN_DATA_LAKE_SLUG_LENGTH } from '@bike4mind/common';
import { Request } from 'express';
import { resolveActiveOrg } from '@server/utils/resolveActiveOrg';

// GET /api/data-lakes/slug-preview?name=&organizationId= - the slug a create with this name would
// get right now (the wizard's Config step). Session-only and internal. It returns only `{ slug }`,
// which says whether a slug is taken in the caller's validated scope. In personal scope that
// namespace is shared by every user's org-less lakes (the unique datalakeTag), so this does tell a
// caller that SOME org-less lake holds a slug - never which lake or whose. Create discloses the same
// through its "-N" suffix, only with the side effect of making a lake.
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    if (req.apiKeyInfo) throw new ForbiddenError('API keys cannot preview data lake slugs');
    const { name, organizationId } = req.query;
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestError('name is required');
    // Create's schema refuses such a slug, so a preview of it would promise a lake that cannot exist.
    if (!isValidDataLakeSlug(name)) {
      throw new BadRequestError(`name must contain at least ${MIN_DATA_LAKE_SLUG_LENGTH} letters or digits`);
    }
    if (organizationId !== undefined && typeof organizationId !== 'string') {
      throw new BadRequestError('organizationId must be a single string');
    }
    // Same org resolution as POST /api/data-lakes, so the preview checks the scope create will use.
    const orgId = await resolveActiveOrg(req, organizationId);
    const slug = await dataLakeService.previewDataLakeSlug({ dataLakes: dataLakeRepository }, name, orgId);
    return res.json({ slug });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
