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
} from '@bike4mind/database';
import {
  ChatModels,
  CONVERSATIONAL_VOICE_MODEL_ID,
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
import { createModelAdmission } from '@server/billing/meterPlatformCompletion';
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HTTPError,
  NotFoundError,
} from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { reserveVoiceHold, settlePriorVoiceHold } from '@bike4mind/server-utils/voice/settleVoiceHold';
import { signVoiceSessionToken } from '@server/voice/voiceSessionToken';
import {
  MAX_SESSION_SECONDS,
  voiceSessionTokenExpiresAtMs,
  shouldReuseVoiceHold,
} from '@bike4mind/server-utils/voice/voiceSessionLimits';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { requestTurnAuth } from '@server/auth/turnAuth';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { admitRequestCompletion } from '@server/utils/untrustedCompletionQuota';

const DEFAULT_MODEL = ChatModels.CLAUDE_4_6_SONNET as ChatModelName;
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
  assertAiAccessAllowed(req.user);
  const { sessionId, reasoningModelId: bodyModelId, isReconnect } = req.validated;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['voiceV2Enabled', 'enforceCredits', 'elevenLabsServerApiKey'], skipCache: true }
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

  // No slot: the call runs on the provider long after this request returns.
  await admitRequestCompletion(req, { holdSlot: false });

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
  const admission = await createModelAdmission(req.user!);
  await admission.assert(CONVERSATIONAL_VOICE_MODEL_ID);
  await admission.assert(reasoningModelId);

  // Always resolve to a real session row so transcripts can be persisted to it.
  // Either attach to an existing notebook or create a new one with a voice-flavored
  // name. The llm-proxy appends voice_transcript quests to this session as the
  // conversation progresses, so the session won't stay empty in normal use.
  let session: ISessionDocument | null = null;
  if (sessionId) {
    // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
    if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');
    session = await sessionRepository.findByIdAndUserId(sessionId, req.user.id);
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

  // A reconnect re-attaches to a session that still holds a live reservation from
  // the original connect. Reuse that hold: skip the second deduction and keep the
  // original voiceSessionStartedAt, so the single end-reconciliation covers the
  // whole call (against MAX_SESSION_SECONDS). Without this, every mobile reconnect
  // would burn another full reserve that's never refunded. Guarded by an explicit
  // live hold so a stray flag can't skip a real charge.
  // ElevenLabs: only a hold without the realtime marker.
  const reuseHold = shouldReuseVoiceHold(isReconnect, session, false);
  // Decided before signing so the token names the hold this call bills against.
  const holdStartedAt =
    reuseHold && session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : new Date();

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
      ...requestTurnAuth(req),
      ...(adminRoleWithheldFor(req.apiKeyInfo) ? { adminRoleWithheld: true } : {}),
      voiceHoldStartedAt: holdStartedAt.toISOString(),
    },
    // Expires with the hold's window, not a fresh window per token: ElevenLabs replays it on every
    // turn, and a reconnect onto the same hold must not extend the call the reserve covers.
    Math.ceil((voiceSessionTokenExpiresAtMs(holdStartedAt) - Date.now()) / 1000)
  );

  const transport = createElevenLabsConversationalTransport({
    apiKey: elevenLabsApiKey,
    agentId: elevenLabsAgentId,
  });

  const estimate = transport.estimateCost(MAX_SESSION_SECONDS);
  const reservedCredits = estimate.creditsToReserve;

  // The hold read before any credit moves; the new hold is written only over it (or over none).
  const priorHoldStartedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : null;
  // A fresh call writes its hold over this session's, so an earlier call left open is settled first.
  if (!reuseHold) {
    await settlePriorVoiceHold(session);
  }

  if (enforceCredits && !reuseHold && (req.user?.currentCredits ?? 0) < reservedCredits) {
    throw insufficientCreditsError(`Insufficient credits for voice session (requires ~${reservedCredits} credits)`);
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

  // The reserve and the hold that records it commit together, after the provider call, so a
  // failure anywhere before this point has nothing to refund. A reconnect keeps the original hold
  // so end-reconciliation measures the full call duration, not just the post-reconnect segment.
  // Drops any realtime marker explicitly: a prior realtime hold with no reserve is never claimed, so
  // its marker would otherwise survive and this ElevenLabs hold would settle as realtime.
  if (!reuseHold) {
    const opened = await reserveVoiceHold({
      userId: req.user.id,
      sessionId: session.id,
      priorStartedAt: priorHoldStartedAt,
      reservedCredits: enforceCredits ? reservedCredits : null,
      startedAt: holdStartedAt,
      realtime: false,
      unaffordable: () =>
        insufficientCreditsError(`Insufficient credits for voice session (requires ~${reservedCredits} credits)`),
    });
    if (!opened) {
      throw new ConflictError('Another voice call on this session started at the same time; retry');
    }
  }

  return res.status(200).json({
    session: { id: session.id, name: session.name },
    reasoningModelId,
    clientBootstrap,
  });
});

export default handler;
