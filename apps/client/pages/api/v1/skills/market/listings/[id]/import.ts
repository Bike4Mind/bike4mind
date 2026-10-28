/** POST /api/v1/skills/market/listings/{id}/import - the public twin of POST /api/skills/market/[id]/import. */
import { ConflictError, importSkillMarketListingContract, isConcurrencyConflictError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { importRateLimit } from '@server/skillMarket/market';
import { importListing } from '@server/skillMarket/importListing';

const handler = nextRouteForContract(importSkillMarketListingContract, { rateLimit: importRateLimit() }).post(
  async (req, res) => {
    const body = req.validated;
    let result;
    try {
      result = await importListing(req.user, req.validatedParams.id, {
        token: body.token,
        name: body.name,
        targetSkillId: body.target_skill_id,
        overwrite: body.overwrite,
        expectedVersionId: body.expected_version_id,
      });
    } catch (error) {
      // A lost race with a concurrent write: retryable, and its filter/reason details are internal.
      if (isConcurrencyConflictError(error)) throw new ConflictError('The skill changed while importing; try again.');
      // The shared logic's 409 classifier is `code` (the SPA's spelling); v1 publishes it as `errorCode`.
      if (error instanceof ConflictError && typeof error.additionalInfo?.code === 'string') {
        const { code, suggestedName } = error.additionalInfo;
        throw new ConflictError(error.message, {
          errorCode: code,
          ...(typeof suggestedName === 'string' ? { suggested_name: suggestedName } : {}),
        });
      }
      throw error;
    }
    return res.status(result.created ? 201 : 200).json({ skill: result.skill });
  }
);

export default handler;

export const config = {
  api: { externalResolver: true },
};
