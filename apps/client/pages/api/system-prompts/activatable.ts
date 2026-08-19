import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { getDefaultSystemPrompts } from '@server/utils/systemPrompts/defaults';
import { isSessionActivatablePromptId } from '@server/utils/sessionActivatablePrompts';

/**
 * GET /api/system-prompts/activatable
 *
 * The registry prompts a session is ALLOWED to activate (the `SESSION_ACTIVATABLE_PROMPT_IDS`
 * allowlist), projected to just what a picker needs: `promptId` + display `name`/`description`.
 * Derived from the code defaults filtered by the allowlist predicate, so it stays the single
 * source of truth - a prompt added to the allowlist appears here automatically, and one removed
 * disappears, with no second list to hand-sync.
 *
 * Feeds the data-lake settings "preferred prompt" picker; gated on the same flag as the lakes it
 * configures. Auth-only (no admin): any lake editor may read the labels for a prompt they can bind.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (_req, res) => {
    const activatable = getDefaultSystemPrompts()
      .filter(prompt => isSessionActivatablePromptId(prompt.promptId))
      .map(({ promptId, name, description }) => ({ promptId, name, description }));
    return res.json({ data: activatable });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
