import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { agentRepository, sessionAgentConfigRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { assertSessionAccess } from '@server/utils/sessionAccess';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const { id: sessionId } = req.query;

    if (typeof sessionId !== 'string') {
      throw new BadRequestError('Invalid session ID');
    }

    await assertSessionAccess(sessionId, req.user!.id);

    const configs = await sessionAgentConfigRepository.findBySessionId(sessionId);

    // Session-level read access doesn't imply access to every agent's config - mirror the
    // single-config route's (agents/[agentId]/config.ts) per-agent check, so a session sharee
    // never sees another agent's proactiveMessaging.systemPrompt just by being on the session.
    const agentIds = [...new Set(configs.map(config => config.agentId))];
    const accessibleAgentIds = agentIds.length
      ? new Set((await agentRepository.shareable.findAllAccessibleByIds(req.user!, agentIds)).map(agent => agent.id))
      : new Set<string>();
    const accessibleConfigs = configs.filter(config => accessibleAgentIds.has(config.agentId));

    res.json({ configs: accessibleConfigs });
  })
);

export default handler;
