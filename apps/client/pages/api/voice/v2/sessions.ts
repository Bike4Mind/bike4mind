import {
  adminSettingsRepository,
  agentRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { ChatModels, type ChatModelName, type IAgent, type ISessionDocument } from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import { BadRequestError, ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { createElevenLabsConversationalTransport } from '@bike4mind/voice';
import { baseApi } from '@server/middlewares/baseApi';
import { signVoiceSessionToken } from '@server/voice/voiceSessionToken';
import { MAX_SESSION_SECONDS, shouldReuseVoiceHold } from '@server/voice/voiceSessionLimits';
import { z } from 'zod';

const CreateSessionBodySchema = z.object({
  sessionId: z.string().optional(),
  reasoningModelId: z.string().optional(),
  // Set by the client when re-establishing a dropped transport. Lets the handler
  // reuse the existing credit hold instead of reserving (and charging) a second time.
  isReconnect: z.boolean().optional(),
});

const DEFAULT_MODEL = ChatModels.CLAUDE_4_6_SONNET as ChatModelName;
// The session token must stay valid for the whole call (ElevenLabs replays it on
// every turn), plus headroom for clock skew and a slightly over-running call.
const SESSION_TOKEN_TTL_SECONDS = MAX_SESSION_SECONDS + 120;
// Mirror v1's concurrency guard so a user (or a leaked session endpoint) can't
// open unbounded parallel calls, each holding a credit reservation.
const MAX_CONCURRENT_VOICE_SESSIONS = 2;

// Temporary remap: Claude Opus 4.7 isn't yet usable because the AWS Marketplace
// subscription for the Bedrock model isn't active. Falls back to 4.6 per-backend
// (Anthropic to Anthropic, Bedrock to Bedrock) so we don't silently switch
// providers under the user. Remove this map once the subscription lands; the
// canonical mapping point is b4m-core/llm-adapters/src/resolveDeprecatedModel.ts.
const VOICE_MODEL_REMAP: Partial<Record<ChatModelName, ChatModelName>> = {
  [ChatModels.CLAUDE_4_7_OPUS]: ChatModels.CLAUDE_4_6_OPUS,
  [ChatModels.CLAUDE_4_7_OPUS_BEDROCK]: ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
  [ChatModels.CLAUDE_4_8_OPUS]: ChatModels.CLAUDE_4_6_OPUS,
  [ChatModels.CLAUDE_4_8_OPUS_BEDROCK]: ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
};

function remapVoiceModel(modelId: ChatModelName): ChatModelName {
  const remapped = VOICE_MODEL_REMAP[modelId];
  if (remapped) {
    // CloudWatch-searchable signal so ops can quantify impact and confirm when
    // the workaround is safe to remove. Mirrors the [model-sunset] convention
    // used by resolveDeprecatedModelId.
    console.warn(`[voice-model-remap] ${modelId} → ${remapped} (reason: #8598/#8761 marketplace subscription pending)`);
    return remapped;
  }
  return modelId;
}

const handler = baseApi().post(async (req, res) => {
  const { sessionId, reasoningModelId: bodyModelId, isReconnect } = CreateSessionBodySchema.parse(req.body);

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['voiceV2Enabled', 'enforceCredits', 'elevenLabsServerApiKey'] }
  );

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  const enforceCredits = getSettingsValue('enforceCredits', settings);

  if (enforceCredits && (req.user?.currentCredits ?? 0) <= 0) {
    throw new ForbiddenError('Out of Credits!');
  }

  const activeVoiceCount = await sessionRepository.countActiveVoiceSessionsByUserId(req.user.id);
  if (activeVoiceCount >= MAX_CONCURRENT_VOICE_SESSIONS) {
    throw new ForbiddenError(`Maximum ${MAX_CONCURRENT_VOICE_SESSIONS} concurrent voice sessions allowed`);
  }

  const elevenLabsApiKey = getSettingsValue('elevenLabsServerApiKey', settings);
  if (!elevenLabsApiKey) {
    return res.status(500).json({
      error: 'ElevenLabs server API key must be configured in admin settings',
    });
  }

  // Always use the org-wide default voice agent. Users no longer pick a voice
  // agent individually - the admin designates one default (isDefaultVoiceAgent)
  // and every voice conversation routes through it. Per-user voice/prompt
  // overrides are layered on below via voiceOverrideId / voiceSystemPromptOverride.
  const voiceAgent: IAgent | null = await agentRepository.findDefaultVoiceAgent();
  if (!voiceAgent || voiceAgent.type !== 'voice' || !voiceAgent.elevenLabsAgentId) {
    throw new BadRequestError('No default voice agent configured. Ask an admin to set one in Voice Settings.');
  }
  const elevenLabsAgentId = voiceAgent.elevenLabsAgentId;

  const reasoningModelId = remapVoiceModel((bodyModelId ?? DEFAULT_MODEL) as ChatModelName);

  // Always resolve to a real session row so transcripts can be persisted to it.
  // Either attach to an existing notebook or create a new one with a voice-flavored
  // name. The llm-proxy appends voice_transcript quests to this session as the
  // conversation progresses, so the session won't stay empty in normal use.
  let session: ISessionDocument | null = null;
  if (sessionId) {
    session = await sessionService.getSession(
      req.user.id,
      { id: sessionId },
      { db: { sessions: sessionRepository, users: userRepository } }
    );
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
  } else {
    session = await sessionService.createSession(
      req.user,
      { name: `Voice • ${reasoningModelId}` },
      { db: { sessions: sessionRepository, projects: projectRepository, fabFiles: fabFileRepository } }
    );
  }

  if (!session) {
    return res.status(500).json({ error: 'Failed to create or retrieve session' });
  }
  const resolvedSessionId = session.id;

  // Sign a session-bound token the proxy verifies on every turn. The browser
  // forwards it to ElevenLabs; the proxy trusts only these claims, never raw
  // request-body fields, so the proxy URL can't be used to impersonate a user.
  // Coerce ids to strings - req.user.organizationId is a Mongo ObjectId, and the
  // token schema (and JWT payload) require plain strings.
  const sessionToken = signVoiceSessionToken(
    {
      userId: String(req.user.id),
      organizationId: req.user.organizationId ? String(req.user.organizationId) : '',
      sessionId: String(resolvedSessionId),
      reasoningModelId,
    },
    SESSION_TOKEN_TTL_SECONDS
  );

  const transport = createElevenLabsConversationalTransport({
    apiKey: elevenLabsApiKey,
    agentId: elevenLabsAgentId,
  });

  const estimate = transport.estimateCost(MAX_SESSION_SECONDS);
  const reservedCredits = estimate.creditsToReserve;

  // A reconnect re-attaches to a session that still holds a live reservation from
  // the original connect. Reuse that hold: skip the second deduction and keep the
  // original voiceSessionStartedAt, so the single end-reconciliation covers the
  // whole call (against MAX_SESSION_SECONDS). Without this, every mobile reconnect
  // would burn another full reserve that's never refunded. Guarded by an explicit
  // live hold so a stray flag can't skip a real charge.
  const reuseHold = shouldReuseVoiceHold(isReconnect, session);

  if (enforceCredits && !reuseHold) {
    if ((req.user?.currentCredits ?? 0) < reservedCredits) {
      throw new ForbiddenError(`Insufficient credits for voice session (requires ~${reservedCredits} credits)`);
    }
    await userRepository.incrementCredits(req.user.id, -reservedCredits);
  }

  let createResult;
  try {
    createResult = await transport.createSession({
      userId: req.user.id,
      organizationId: req.user.organizationId ?? '',
      sessionId: resolvedSessionId,
      reasoningModelId,
      tools: [],
      systemPrompt: '',
      sessionToken,
      ...(req.user.voiceOverrideId ? { voiceOverrideId: req.user.voiceOverrideId } : {}),
      ...(req.user.voiceSystemPromptOverride ? { systemPromptOverride: req.user.voiceSystemPromptOverride } : {}),
    });
  } catch (error) {
    if (enforceCredits && !reuseHold) {
      await userRepository.incrementCredits(req.user.id, reservedCredits);
    }
    const errDetail =
      error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : { message: String(error) };
    req.logger.error('[voice-v2/sessions] transport.createSession failed', { err: errDetail });
    // P0 probe: include the underlying error message in the response so the
    // browser can show it without tailing SST logs.
    // TODO(voice-v2-P1): redact this once we're past the probe phase.
    const detail = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: 'Failed to provision voice transport', detail });
  }

  // A reconnect leaves the original reservation record untouched so end-reconciliation
  // measures the full call duration, not just the post-reconnect segment.
  if (!reuseHold) {
    const voiceSessionStartedAt = new Date();
    await sessionRepository.update({
      id: session.id,
      voiceReservedCredits: enforceCredits ? reservedCredits : null,
      voiceSessionStartedAt,
    });
  }

  return res.status(200).json({
    session: { id: session.id, name: session.name },
    reasoningModelId,
    clientBootstrap: createResult.clientBootstrap,
  });
});

export default handler;
