import { adminSettingsRepository, agentRepository } from '@bike4mind/database';
import { BadRequestError, ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { createElevenLabsAgent, DEFAULT_TURN_EAGERNESS, SILENCE_TURN_TIMEOUT_SECONDS } from '@bike4mind/voice';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const DEFAULT_FIRST_MESSAGE = 'Hello! How can I help you today?';

const CreateVoiceAgentBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  voiceId: z.string().min(1),
  systemPrompt: z.string().min(1),
  firstMessage: z.string().max(500).optional().default(DEFAULT_FIRST_MESSAGE),
  language: z.string().optional(),
  turnEagerness: z.enum(['patient', 'normal', 'eager']).optional(),
  turnTimeoutSeconds: z.number().int().min(1).max(30).optional(),
});

function getCustomLlmUrl(req: { headers: { host?: string; 'x-forwarded-proto'?: string } }): string {
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers.host;
  if (!host) throw new Error('Cannot resolve host for custom LLM URL');
  return `${proto}://${host}/api/voice/v2/llm-proxy`;
}

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }
    const agents = await agentRepository.listAllVoiceAgents();
    return res.status(200).json({ agents });
  })
  .post(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const body = CreateVoiceAgentBodySchema.parse(req.body);

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['voiceV2Enabled', 'elevenLabsServerApiKey'] }
    );
    if (!getSettingsValue('voiceV2Enabled', settings)) {
      throw new BadRequestError('Voice v2 must be enabled before creating voice agents.');
    }
    const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
    if (!apiKey) {
      throw new BadRequestError('ElevenLabs server API key must be configured before creating voice agents.');
    }

    const customLlmUrl = getCustomLlmUrl({
      headers: {
        host: req.headers.host,
        'x-forwarded-proto': Array.isArray(req.headers['x-forwarded-proto'])
          ? req.headers['x-forwarded-proto'][0]
          : req.headers['x-forwarded-proto'],
      },
    });

    // The first voice agent becomes the org-wide default automatically. Voice
    // sessions route through the default agent and fail until one is set, so a
    // sole agent should never be left non-default. With no other voice agents
    // yet, setting the flag here trivially preserves the at-most-one invariant.
    const isFirstVoiceAgent = (await agentRepository.listAllVoiceAgents()).length === 0;

    let elevenLabsAgentId: string;
    try {
      const result = await createElevenLabsAgent(apiKey, {
        name: body.name,
        voiceId: body.voiceId,
        systemPrompt: body.systemPrompt,
        firstMessage: body.firstMessage,
        customLlmUrl,
        ...(body.language ? { language: body.language } : {}),
        ...(body.turnEagerness ? { turnEagerness: body.turnEagerness } : {}),
        ...(body.turnTimeoutSeconds !== undefined ? { turnTimeoutSeconds: body.turnTimeoutSeconds } : {}),
      });
      elevenLabsAgentId = result.agentId;
    } catch (error) {
      req.logger.error({ err: error }, '[admin/voice-agents] ElevenLabs createAgent failed');
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(502).json({ error: 'Failed to create ElevenLabs agent', detail });
    }

    const agent = await agentRepository.create({
      name: body.name,
      description: body.description ?? '',
      type: 'voice',
      provider: 'elevenlabs',
      elevenLabsAgentId,
      elevenLabsVoiceId: body.voiceId,
      firstMessage: body.firstMessage,
      // Mirror the applied turn-taking settings - defaults imported from
      // createElevenLabsAgent's source so the persisted record can't drift from
      // what ElevenLabs actually received.
      turnEagerness: body.turnEagerness ?? DEFAULT_TURN_EAGERNESS,
      turnTimeoutSeconds: body.turnTimeoutSeconds ?? SILENCE_TURN_TIMEOUT_SECONDS,
      isSystem: true,
      isPublic: true,
      isDefaultVoiceAgent: isFirstVoiceAgent,
      triggerWords: [],
      capabilities: [],
      useOwnCredits: false,
      currentCredits: 0,
      systemPrompt: body.systemPrompt,
      personality: {
        majorMotivation: '',
        minorMotivation: '',
        flaw: '',
        quirk: '',
        description: '',
      },
      visual: { portraitUrl: '', style: 'modern', generationPrompt: '' },
      identity: {
        gender: 'prefer-not-to-say',
        pronouns: { subject: '', object: '', possessive: '', possessiveAdjective: '', reflexive: '' },
      },
      isGlobalRead: true,
      isGlobalWrite: false,
      users: [],
      groups: [],
    } as never);

    return res.status(201).json({ agent });
  });

export default handler;
