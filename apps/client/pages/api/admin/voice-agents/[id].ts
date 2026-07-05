import { adminSettingsRepository, agentRepository } from '@bike4mind/database';
import { BadRequestError, ForbiddenError, NotFoundError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { deleteElevenLabsAgent, getElevenLabsAgent, updateElevenLabsAgent } from '@bike4mind/voice';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const UpdateVoiceAgentBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  voiceId: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  firstMessage: z.string().max(500).optional(),
  language: z.string().optional(),
  turnEagerness: z.enum(['patient', 'normal', 'eager']).optional(),
  turnTimeoutSeconds: z.number().int().min(1).max(30).optional(),
  isDefault: z.boolean().optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const id = typeof req.query.id === 'string' ? req.query.id : null;
    if (!id) throw new NotFoundError('Agent ID required');

    const agent = await agentRepository.findById(id);
    if (!agent || agent.type !== 'voice') {
      throw new NotFoundError('Voice agent not found');
    }
    if (!agent.elevenLabsAgentId) {
      throw new BadRequestError('Voice agent is missing its ElevenLabs agent ID.');
    }

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['elevenLabsServerApiKey'] }
    );
    const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
    if (!apiKey) {
      throw new BadRequestError('ElevenLabs server API key must be configured.');
    }

    try {
      const config = await getElevenLabsAgent(apiKey, agent.elevenLabsAgentId);
      return res.status(200).json({ config });
    } catch (error) {
      req.logger.error({ err: error }, '[admin/voice-agents] ElevenLabs fetch failed');
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: 'Failed to fetch ElevenLabs agent config', detail });
    }
  })
  .patch(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const id = typeof req.query.id === 'string' ? req.query.id : null;
    if (!id) throw new NotFoundError('Agent ID required');

    const agent = await agentRepository.findById(id);
    if (!agent || agent.type !== 'voice') {
      throw new NotFoundError('Voice agent not found');
    }

    const body = UpdateVoiceAgentBodySchema.parse(req.body);

    // Push ElevenLabs-relevant changes (name, voice, prompt, turn-taking) to the agent.
    const needsElevenLabsUpdate =
      body.name !== undefined ||
      body.voiceId !== undefined ||
      body.systemPrompt !== undefined ||
      body.firstMessage !== undefined ||
      body.language !== undefined ||
      body.turnEagerness !== undefined ||
      body.turnTimeoutSeconds !== undefined;

    if (needsElevenLabsUpdate) {
      if (!agent.elevenLabsAgentId) {
        throw new BadRequestError('Voice agent is missing its ElevenLabs agent ID; cannot update.');
      }
      const settings = await getSettingsMap(
        { adminSettings: adminSettingsRepository },
        { names: ['elevenLabsServerApiKey'] }
      );
      const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
      if (!apiKey) {
        throw new BadRequestError('ElevenLabs server API key must be configured.');
      }
      try {
        await updateElevenLabsAgent(apiKey, agent.elevenLabsAgentId, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.voiceId !== undefined ? { voiceId: body.voiceId } : {}),
          ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
          ...(body.firstMessage !== undefined ? { firstMessage: body.firstMessage } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
          ...(body.turnEagerness !== undefined ? { turnEagerness: body.turnEagerness } : {}),
          ...(body.turnTimeoutSeconds !== undefined ? { turnTimeoutSeconds: body.turnTimeoutSeconds } : {}),
        });
      } catch (error) {
        req.logger.error({ err: error }, '[admin/voice-agents] ElevenLabs update failed');
        const detail = error instanceof Error ? error.message : String(error);
        return res.status(502).json({ error: 'Failed to update ElevenLabs agent', detail });
      }
    }

    // Mirror the editable fields onto the B4M agent document.
    await agentRepository.update({
      id,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
      ...(body.voiceId !== undefined ? { elevenLabsVoiceId: body.voiceId } : {}),
      ...(body.firstMessage !== undefined ? { firstMessage: body.firstMessage } : {}),
      ...(body.turnEagerness !== undefined ? { turnEagerness: body.turnEagerness } : {}),
      ...(body.turnTimeoutSeconds !== undefined ? { turnTimeoutSeconds: body.turnTimeoutSeconds } : {}),
    });

    // Default flag enforces the at-most-one invariant across voice agents.
    if (body.isDefault === true) {
      await agentRepository.setDefaultVoiceAgent(id);
    } else if (body.isDefault === false) {
      await agentRepository.update({ id, isDefaultVoiceAgent: false });
    }

    const updated = await agentRepository.findById(id);
    return res.status(200).json({ agent: updated });
  })
  .delete(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const id = typeof req.query.id === 'string' ? req.query.id : null;
    if (!id) throw new NotFoundError('Agent ID required');

    const agent = await agentRepository.findById(id);
    if (!agent || agent.type !== 'voice') {
      throw new NotFoundError('Voice agent not found');
    }

    if (agent.elevenLabsAgentId) {
      const settings = await getSettingsMap(
        { adminSettings: adminSettingsRepository },
        { names: ['elevenLabsServerApiKey'] }
      );
      const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
      if (apiKey) {
        try {
          await deleteElevenLabsAgent(apiKey, agent.elevenLabsAgentId);
        } catch (error) {
          // Best-effort cleanup; the B4M record removal is what users care about.
          req.logger.warn(
            { err: error, agentId: agent.elevenLabsAgentId },
            '[admin/voice-agents] ElevenLabs delete failed; continuing with B4M deletion'
          );
        }
      }
    }

    await agentRepository.delete(id);

    // If the deleted agent was the default, promote the next surviving agent.
    if (agent.isDefaultVoiceAgent) {
      const remaining = await agentRepository.listAllVoiceAgents();
      if (remaining.length > 0) {
        await agentRepository.setDefaultVoiceAgent(remaining[0].id);
      }
    }

    return res.status(200).json({ ok: true });
  });

export default handler;
