import { baseApi } from '@server/middlewares/baseApi';
import { sessionRepository, agentRepository, sessionAgentConfigRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertSessionAccess } from '@server/utils/sessionAccess';
import { z } from 'zod';

const proactiveMessagingSchema = z.object({
  enabled: z.boolean(),
  activeHours: z.object({
    startHour: z.int().min(0).max(23),
    endHour: z.int().min(0).max(23),
    timezone: z.string().optional(),
  }),
  systemPrompt: z.string().max(2000).optional(),
  minIntervalHours: z.int().min(1).optional(),
});

const updateConfigSchema = z.object({
  proactiveMessaging: proactiveMessagingSchema,
});

/**
 * Agent-level authz + attachment check, shared by all three verbs below: does the caller have
 * access to the agent itself (owner, user-share, or group-share - the same object-level
 * predicate agents.ts's POST agent-attach handler uses), and is that agent actually attached to
 * this session. Independent
 * of the session-level assertSessionAccess call above each one - that only proves the caller
 * belongs to THIS session, not that they may reach THIS agent's config.
 */
async function assertAgentAttached(
  user: Parameters<typeof agentRepository.shareable.findAccessibleById>[0],
  sessionId: string,
  agentId: string
): Promise<void> {
  const agent = await agentRepository.shareable.findAccessibleById(user, agentId);
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  const agentIds = await sessionRepository.getAttachedAgents(sessionId);
  if (!agentIds.includes(agentId)) {
    throw new BadRequestError('Agent is not attached to this session');
  }
}

const handler = baseApi()
  .get(async (req, res) => {
    const { id: sessionId, agentId } = req.query;

    if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
      throw new BadRequestError('Invalid session ID or agent ID');
    }

    await assertSessionAccess(sessionId, req.user!.id);
    await assertAgentAttached(req.user!, sessionId, agentId);

    const config = await sessionAgentConfigRepository.findBySessionAndAgent(sessionId, agentId);

    res.json({ config });
  })
  .put(async (req, res) => {
    const { id: sessionId, agentId } = req.query;
    const { proactiveMessaging } = req.body;

    if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
      throw new BadRequestError('Invalid session ID or agent ID');
    }

    const validatedData = updateConfigSchema.parse({ proactiveMessaging });

    await assertSessionAccess(sessionId, req.user!.id, 'write', req.user!.groups ?? []);
    await assertAgentAttached(req.user!, sessionId, agentId);

    const existingConfig = await sessionAgentConfigRepository.findBySessionAndAgent(sessionId, agentId);

    let config;
    if (existingConfig) {
      // Re-stamp userId to the caller on every update: this config's userId is who the
      // proactive-messaging worker later executes and bills as (agentProactiveMessage.ts), so
      // it must always be whoever last authored proactiveMessaging.systemPrompt, never whoever
      // happened to create the row first - otherwise a session write-sharee could rewrite the
      // prompt while leaving it to run under the original owner's identity, keys, and tools.
      config = await sessionAgentConfigRepository.update({
        ...existingConfig,
        userId: req.user!.id,
        proactiveMessaging: {
          ...validatedData.proactiveMessaging,
          // Preserve lastProactiveMessageAt if not being reset
          lastProactiveMessageAt: existingConfig.proactiveMessaging.lastProactiveMessageAt,
        },
      });
    } else {
      // Create new config
      config = await sessionAgentConfigRepository.create({
        sessionId,
        agentId,
        userId: req.user!.id,
        proactiveMessaging: validatedData.proactiveMessaging,
      });
    }

    if (!config) {
      throw new BadRequestError('Failed to save config');
    }

    res.json({ config });
  })
  .delete(async (req, res) => {
    const { id: sessionId, agentId } = req.query;

    if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
      throw new BadRequestError('Invalid session ID or agent ID');
    }

    await assertSessionAccess(sessionId, req.user!.id, 'write', req.user!.groups ?? []);
    await assertAgentAttached(req.user!, sessionId, agentId);

    // A write-sharee can delete a config they can't trigger (trigger-proactive-messages.ts only
    // fires configs the caller owns) - intentional: deletion doesn't run anyone else's prompt or
    // spend anyone else's credits, so it doesn't need the same per-owner restriction.
    await sessionAgentConfigRepository.deleteBySessionAndAgent(sessionId, agentId);

    res.json({ success: true });
  });

export default handler;
