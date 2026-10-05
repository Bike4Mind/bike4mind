import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository } from '@bike4mind/database';
import { BadRequestError, ForbiddenError } from '@bike4mind/common';
import { Request } from 'express';
import { resolveActiveOrg } from '@server/utils/resolveActiveOrg';

// GET /api/data-lakes/slug-preview?name=&organizationId= - the slug a create with this name would
// get right now (the wizard's Config step). Session-only and internal. It returns only `{ slug }`:
// that a slug is taken in the caller's validated org scope, which create already reveals.
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    if (req.apiKeyInfo) throw new ForbiddenError('API keys cannot preview data lake slugs');
    const { name, organizationId } = req.query;
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestError('name is required');
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
