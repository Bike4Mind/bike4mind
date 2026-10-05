/**
 * POST /api/v1/voice/sessions - provision a real-time ElevenLabs voice call on the default voice
 * agent and reserve its credits up front (reconciled by ./[id]/end.ts). Also served at the legacy
 * `/api/voice/v2/sessions` (re-exported there), which the SPA calls. Auth mode, the `ai:generate`
 * scope and body validation come from `createVoiceSessionContract`.
 */
import {
  adminSettingsRepository,
  agentRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import {
  ChatModels,
  createVoiceSessionContract,
  insufficientCreditsError,
  type ChatModelName,
  type IAgent,
  type ISessionDocument,
  type VoiceClientBootstrap,
} from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { createElevenLabsConversationalTransport, type ElevenLabsClientBootstrap } from '@bike4mind/voice';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { BadGatewayError, BadRequestError, ForbiddenError, HTTPError, NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { signVoiceSessionToken } from '@server/voice/voiceSessionToken';
import { MAX_SESSION_SECONDS, shouldReuseVoiceHold } from '@server/voice/voiceSessionLimits';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';

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
    console.warn(`[voice-model-remap] ${modelId} -> ${remapped} (reason: marketplace subscription pending)`);
    return remapped;
  }
  return modelId;
}

const handler = nextRouteForContract(createVoiceSessionContract).post(async (req, res) => {
  const { sessionId, reasoningModelId: bodyModelId, isReconnect } = req.validated;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['voiceV2Enabled', 'enforceCredits', 'elevenLabsServerApiKey'] }
  );

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  const enforceCredits = getSettingsValue('enforceCredits', settings);

  if (enforceCredits && (req.user?.currentCredits ?? 0) <= 0) {
    throw insufficientCreditsError('Out of Credits!');
  }

  const activeVoiceCount = await sessionRepository.countActiveVoiceSessionsByUserId(req.user.id);
  if (activeVoiceCount >= MAX_CONCURRENT_VOICE_SESSIONS) {
    throw new ForbiddenError(`Maximum ${MAX_CONCURRENT_VOICE_SESSIONS} concurrent voice sessions allowed`);
  }

  const elevenLabsApiKey = getSettingsValue('elevenLabsServerApiKey', settings);
  if (!elevenLabsApiKey) {
    throw new HTTPError(503, 'ElevenLabs server API key must be configured in admin settings', {
      errorCode: 'provider_not_configured',
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
    // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
    if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');
    session = await sessionService.getSession(
      req.user.id,
      { id: sessionId },
      { db: { sessions: sessionRepository, users: userRepository } }
    );
    if (!session) {
      throw new NotFoundError('Session not found');
    }
  } else {
    session = await sessionService.createSession(
      req.user,
      { name: `Voice \u2022 ${reasoningModelId}` },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          agents: agentRepository,
        },
        // Imported at CALL time - see the other call sites.
        // See resolveRetrievalLakeScopeForUser - request-free so the lake arm of the lake-tag
        // derivation runs here too, not only on the two session routes that have a `req`.
        resolveLakeAccess: async () =>
          (await import('@server/dataLakes/resolveRetrievalLakeScope')).resolveRetrievalLakeScopeForUser(req.user!),
      },
      { origin: resolveSessionOrigin(req) }
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
      throw insufficientCreditsError(`Insufficient credits for voice session (requires ~${reservedCredits} credits)`);
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
    // The upstream message can echo provider internals, so it stays in the log, not the body.
    req.logger.error('[voice-v2/sessions] transport.createSession failed', { err: errDetail });
    throw new BadGatewayError('Failed to provision voice transport');
  }

  // The transport interface types the bootstrap as `unknown`; this assignment pins the ElevenLabs
  // shape to the published response schema at compile time.
  const clientBootstrap: VoiceClientBootstrap = createResult.clientBootstrap as ElevenLabsClientBootstrap;

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
    clientBootstrap,
  });
});

export default handler;
