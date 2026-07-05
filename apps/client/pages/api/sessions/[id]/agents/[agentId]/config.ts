import { baseApi } from '@server/middlewares/baseApi';
import { sessionRepository, agentRepository, sessionAgentConfigRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
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

const handler = baseApi()
  .get(async (req, res) => {
    const { id: sessionId, agentId } = req.query;

    if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
      throw new BadRequestError('Invalid session ID or agent ID');
    }

    // Verify session exists and user has access
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.userId !== req.user!.id) {
      throw new UnauthorizedError('Unauthorized');
    }

    // Verify agent exists and user has access
    const agent = await agentRepository.findById(agentId);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    const isSharedWithUser = agent.users?.some((u: { userId: string }) => u.userId === req.user!.id);
    if (agent.userId !== req.user!.id && !isSharedWithUser) {
      throw new NotFoundError('Agent not found');
    }

    // Check if agent is attached to session
    const agentIds = await sessionRepository.getAttachedAgents(sessionId);
    if (!agentIds.includes(agentId)) {
      throw new BadRequestError('Agent is not attached to this session');
    }

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

    // Verify session exists and user has access
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.userId !== req.user!.id) {
      throw new UnauthorizedError('Unauthorized');
    }

    // Verify agent exists and user has access
    const agent = await agentRepository.findById(agentId);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    const isSharedWithUser = agent.users?.some((u: { userId: string }) => u.userId === req.user!.id);
    if (agent.userId !== req.user!.id && !isSharedWithUser) {
      throw new NotFoundError('Agent not found');
    }

    // Check if agent is attached to session
    const agentIds = await sessionRepository.getAttachedAgents(sessionId);
    if (!agentIds.includes(agentId)) {
      throw new BadRequestError('Agent is not attached to this session');
    }

    const existingConfig = await sessionAgentConfigRepository.findBySessionAndAgent(sessionId, agentId);

    let config;
    if (existingConfig) {
      // Update existing config
      config = await sessionAgentConfigRepository.update({
        ...existingConfig,
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

    // Verify session exists and user has access
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    if (session.userId !== req.user!.id) {
      throw new UnauthorizedError('Unauthorized');
    }

    await sessionAgentConfigRepository.deleteBySessionAndAgent(sessionId, agentId);

    res.json({ success: true });
  });

export default handler;
