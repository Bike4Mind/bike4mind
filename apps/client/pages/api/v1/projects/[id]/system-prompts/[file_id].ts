/**
 * PATCH  /api/v1/projects/{id}/system-prompts/{file_id} - sets what POST /api/projects/[id]/systemPrompts/toggle flips.
 * DELETE /api/v1/projects/{id}/system-prompts/{file_id} - the single-file twin of DELETE /api/projects/[id]/systemPrompts.
 *
 * The file is named `[file_id]` so Next's dynamic segment matches the contract's path parameter.
 */
import { removeProjectSystemPromptContract, updateProjectSystemPromptContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { removeProjectSystemPrompts, setProjectSystemPrompt } from '@server/projects/projectSharingMutations';
import { toPublicSystemPrompts } from '@server/projects/toPublicSystemPrompts';

const updateRoute = nextRouteForContract(updateProjectSystemPromptContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/projects/[id]/system-prompts/[file_id]'),
}).patch(async (req, res) => {
  const { id, file_id: fileId } = req.validatedParams;
  const project = await setProjectSystemPrompt(
    { user: req.user, ability: req.ability, logger: req.logger },
    id,
    fileId,
    req.validated.enabled
  );
  return res.json(toPublicSystemPrompts(project));
});

const removeRoute = nextRouteForContract(removeProjectSystemPromptContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/projects/[id]/system-prompts/[file_id]'),
}).delete(async (req, res) => {
  const { id, file_id: fileId } = req.validatedParams;
  await removeProjectSystemPrompts({ user: req.user, ability: req.ability, logger: req.logger }, id, [fileId]);
  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ PATCH: updateRoute, DELETE: removeRoute });
