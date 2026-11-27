/**
 * POST /api/v1/projects/{id}/system-prompts - the public twin of POST /api/projects/[id]/systemPrompts.
 */
import { addProjectSystemPromptsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { addProjectSystemPrompts } from '@server/projects/projectSharingMutations';
import { toPublicSystemPrompts } from '@server/projects/toPublicSystemPrompts';

const addRoute = nextRouteForContract(addProjectSystemPromptsContract, {
  rateLimit: perUserRateLimit('POST /api/v1/projects/[id]/system-prompts'),
}).post(async (req, res) => {
  const project = await addProjectSystemPrompts(
    { user: req.user, ability: req.ability, logger: req.logger },
    req.validatedParams.id,
    req.validated.file_ids
  );
  return res.json(toPublicSystemPrompts(project));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ POST: addRoute });
