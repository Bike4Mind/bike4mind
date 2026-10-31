// Voice v2 LLM proxy - OpenAI Chat Completions-compatible streaming endpoint.
//
// Path mirrors ElevenLabs Conversational AI's Custom LLM URL convention:
// the agent's "Server URL" is configured to <host>/api/voice/v2/llm-proxy,
// and ElevenLabs appends "/chat/completions" when making the actual request,
// so the file lives at that suffix. This is the canonical (and only) location
// of the handler.
import { DATA_LAKE_TOOL_NAMES, questGenerationJobs } from '@bike4mind/common';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { adminSettingsRepository, questRepository, sessionRepository, userRepository } from '@bike4mind/database';
import {
  ChatCompletionFeature,
  ChatCompletionInvoke,
  ChatCompletionProcess,
  featureNames,
  type ToolDefinition,
} from '@bike4mind/services/llm';
import { getSettingsMap, getSettingsValue, type IQueueService } from '@bike4mind/utils';
import { stripToolOutputMarker } from '@bike4mind/utils/artifactParser';
import { type Logger, describeErrorCause } from '@bike4mind/observability';
import {
  buildClientToolPassthrough,
  currentTurnUserMessage,
  diffAccumulated,
  extractSystemPrompt,
  emitInitialBuffer,
  openAiSseChunk,
  openAiSseDone,
  stripSpokenThinking,
  writeStaticCompletion,
  type CapturedToolCall,
  type OpenAIChatRequest,
} from '@bike4mind/voice';
import { getDefaultChatCompletionOptions, getSharedTokenizer } from '@server/utils/chatCompletionDefaults';
import { baseApi } from '@server/middlewares/baseApi';
import { ownerWithheldUsers, withholdAdminRole } from '@server/auth/apiKeyAdminScope';
import { premiumLlmTools } from '@bike4mind/server-utils/premium-generated/premiumLlmTools.generated';
import { getCreateVideoJobDeps, getVideoJobDeps } from '@server/generationJobs/wiring';
import { buildVideoToolConfig } from '@bike4mind/server-utils/videoGenerations/buildVideoToolConfig';
import { getVoiceVideoToolConfigResolver } from '@server/videoGenerations/voiceVideoToolConfig';
import { verifyVoiceSessionToken, type VoiceSessionContext } from '@server/voice/voiceSessionToken';
import { voiceSessionTokenExpiresAtMs } from '@bike4mind/server-utils/voice/voiceSessionLimits';
import { createCompletionMeter } from '@server/billing/meterPlatformCompletion';

// Built-in tools enabled for voice turns. Curated to ones that execute INLINE
// (no SQS/Lambda dispatch): web search, knowledge-base RAG, datetime,
// weather, and math. Deliberately excludes image generation, deep_research,
// jupyter/excel, and delegate_to_agent - those run out-of-process. `navigate_view`
// is auto-added by ChatCompletionProcess regardless. `video_generation` is added per
// turn (see runFullPipeline): it only enqueues a job, and the clip arrives later in the chat.
const VOICE_BUILTIN_TOOLS = [
  'web_search',
  'search_knowledge_base',
  'retrieve_knowledge_content',
  'current_datetime',
  'weather_info',
  'wolfram_alpha',
  'math_evaluate',
];

// No-op queue: satisfies the ChatCompletionProcess option type without ever
// dispatching to SQS. Voice turns run fully in-process; nothing should enqueue on this
// chat queue (a video job enqueues on its own generation queue, which this does not touch),
// and if some path tries, this swallows it instead of hitting the queue.
const noopQueue: IQueueService = {
  async sendMessage() {
    return undefined;
  },
};

// How far back to look for an in-flight duplicate of this turn. ElevenLabs
// retries a slow voice turn within seconds, so a short window is plenty.
const DUPLICATE_LOOKBACK_MS = 60_000;

type DuplicateTurn = 'in-flight' | 'video-started';

/**
 * Whether this turn repeats one already handled. ElevenLabs retries a slow turn
 * (the proxy buffers the whole reply, and tools add latency), and each retry
 * would otherwise run a fresh ChatCompletionProcess and create a duplicate
 * quest. A quest is marked `running` the moment it's created and only flips to
 * `done` when the reply is ready, so a still-running quest in this session with
 * the same prompt means the original turn is mid-flight - drop the retry.
 *
 * A dropped connection marks the quest `stopped` but leaves any video job its
 * tool call already created (and billed) running, and a retry gets a fresh quest
 * so the job's idempotency key never matches. A recent quest with the same prompt
 * that is `stopped` yet already started a video job therefore also counts as a
 * duplicate. The video claim is taken before the job is created, so a retry
 * during the tool call still sees it. A normally `done` turn does not: a user may repeat the sentence to
 * ask for another clip.
 */
async function findDuplicateTurn(sessionId: string, message: string): Promise<DuplicateTurn | null> {
  const cutoff = new Date(Date.now() - DUPLICATE_LOOKBACK_MS);
  const recent = await questRepository.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(sessionId, cutoff);
  const sameTurn = recent.filter(q => q.prompt === message);
  if (sameTurn.some(q => q.status === 'running')) return 'in-flight';
  if (
    sameTurn.some(
      q =>
        q.status === 'stopped' &&
        (questGenerationJobs(q).some(job => job.kind === 'video') || (q.agentVideoClipsClaimed ?? 0) > 0)
    )
  ) {
    return 'video-started';
  }
  return null;
}

/**
 * Run a single voice turn through the full B4M chat pipeline (RAG, tools, MCP,
 * mementos, credit accounting) and return the assistant's reply text.
 *
 * ChatCompletionProcess builds conversation context from the B4M session (the
 * voice_transcript quests persisted per turn), so we pass only the latest user
 * utterance as `message`. The process streams incrementally and mutates the
 * quest in place; we forward each streamed reply update via `onReplyStream` so
 * the proxy can emit SSE token deltas (keeping ElevenLabs under its
 * time-to-first-token timeout) and return the final reply once it resolves.
 */
async function runFullPipeline(
  sessionCtx: VoiceSessionContext,
  message: string,
  systemPrompt: string,
  logger: Logger,
  onReplyStream: (fullReplyText: string) => void,
  onQuestCreated: (questId: string) => void,
  // ElevenLabs system tools (end_call, ...) the model may call; passed through to
  // the pipeline so it offers them to the model and we can echo the calls back.
  clientTools: Record<string, ToolDefinition>
): Promise<string> {
  const storedUser = await userRepository.findById(sessionCtx.userId);
  if (!storedUser) throw new Error(`Voice v2: user not found for id ${sessionCtx.userId}`);
  const user = sessionCtx.adminRoleWithheld ? withholdAdminRole(storedUser) : storedUser;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['defaultEmbeddingModel'] }
  );
  const embeddingModel = getSettingsValue('defaultEmbeddingModel', settings);
  const organizationId = sessionCtx.organizationId || undefined;
  const videoToolConfigResolver = getVoiceVideoToolConfigResolver(sessionCtx, userId =>
    buildVideoToolConfig(userId, { availability: getVideoJobDeps(), createDeps: getCreateVideoJobDeps() })
  );

  const chatCompletionOptions = {
    ...getDefaultChatCompletionOptions(),
    queue: noopQueue,
    tokenizer: getSharedTokenizer(logger),
    user,
    sessionId: sessionCtx.sessionId,
    gpcSignalDetected: false,
    features: new Map<featureNames, ChatCompletionFeature>(),
    logger,
    createCompletionMeter: ({
      organizationId,
      featureLabel,
    }: {
      organizationId: string | null;
      featureLabel: string;
    }) =>
      createCompletionMeter(user, logger, featureLabel, {
        sessionId: sessionCtx.sessionId,
        organizationId,
        apiKeyId: sessionCtx.apiKeyId,
      }),
    // Forward streamed reply updates to the SSE writer in the handler.
    onReplyStream,
    // No-op: we run process() inline in this request handler, so we deliberately
    // do NOT dispatch out-of-process (to the ChatCompletion service). invoke() requires
    // a callback (it throws if missing) but we want zero out-of-process work - the
    // whole completion happens synchronously here.
    invokeLambda: async () => {},
  };
  // A tool that re-reads the owner by id must see the same withheld role as `user`. Kept out of the
  // literal above so it still spreads getDefaultChatCompletionOptions() (see sessionSystemPromptWiring.test.ts).
  if (sessionCtx.adminRoleWithheld) {
    chatCompletionOptions.db = {
      ...chatCompletionOptions.db,
      users: ownerWithheldUsers(sessionCtx.userId, chatCompletionOptions.db.users),
    };
  }

  const invokeBody = {
    sessionId: sessionCtx.sessionId,
    message,
    historyCount: 10,
    fabFileIds: [],
    messageFileIds: [],
    organizationId,
    // stream:true so the model emits tokens incrementally - ChatCompletionProcess
    // fires onReplyStream on each chunk, and the proxy relays SSE deltas.
    // No max_tokens: ChatCompletionProcess sizes it per model, so a reasoning model keeps room to answer.
    params: { model: sessionCtx.reasoningModelId, stream: true },
    promptMeta: { session: { id: sessionCtx.sessionId, userId: sessionCtx.userId, organizationId } },
    enableArtifacts: false,
    // Enable the inline built-in tools (web search, RAG, etc.) plus any ElevenLabs
    // client tools for this turn. Without the builtins the agent can't search the
    // web. QuestMaster, Agents (subagent Lambda handoff), and Mementos (async
    // creation) stay off so the whole voice turn runs in-process - no separate
    // Lambda or SQS dispatch. The one exception is video_generation, which only enqueues a job.
    tools: [
      ...VOICE_BUILTIN_TOOLS,
      ...(videoToolConfigResolver ? ['video_generation'] : []),
      ...Object.keys(clientTools),
    ],
    // The save-intent gate would otherwise offer the data-lake tools past the list above.
    deniedTools: [...DATA_LAKE_TOOL_NAMES],
    enableQuestMaster: false,
    enableMementos: false,
    enableAgents: false,
    // Speech streams from the raw reply, so a choices block would be read aloud; there are no buttons.
    skipReplyChoices: true,
    // Inject the voice agent's system prompt (ElevenLabs-rendered, incl. per-user
    // override) at the top of the context so it drives the response persona.
    ...(systemPrompt ? { extraContextMessages: [{ role: 'system' as const, content: systemPrompt }] } : {}),
  };

  const invokeService = new ChatCompletionInvoke(chatCompletionOptions);
  const quest = await invokeService.invoke({
    body: invokeBody,
    userId: sessionCtx.userId,
    authOrigin: sessionCtx.authOrigin,
    apiKeyId: sessionCtx.apiKeyId,
  });
  if (!quest) throw new Error('Voice v2: failed to create quest');
  // Surface the quest id so the handler can stop it if the client disconnects.
  onQuestCreated(quest.id);

  const processService = new ChatCompletionProcess(chatCompletionOptions);
  await processService.process({
    body: {
      ...invokeBody,
      questId: quest.id,
      userId: sessionCtx.userId,
      // From the verified token, never the request body. process() reads the tool context's auth
      // from this body only.
      authOrigin: sessionCtx.authOrigin,
      apiKeyId: sessionCtx.apiKeyId,
      embeddingModel,
      queryComplexity: 'simple',
      dashboardParams: undefined,
      questMaster: undefined,
      researchMode: undefined,
      imageConfig: undefined,
    },
    logger,
    prefetchedQuest: quest,
    prefetchedSession: invokeService.prefetchedSession,
    prefetchedOrganization: invokeService.prefetchedOrganization,
    // Offer ElevenLabs' client tools to the model alongside the built-ins. Their
    // executors only capture the call; ElevenLabs runs the real side effect.
    // Premium overlay tool implementations merge first so client tools win.
    externalTools: { ...premiumLlmTools, ...clientTools },
    videoToolConfigResolver,
  });

  // process() mutates the quest in place. Use the last reply item (the visible
  // answer after any thinking reply) to match what onReplyStream forwarded.
  const reply = stripToolOutputMarker(quest.replies?.[quest.replies.length - 1] ?? quest.reply ?? '');
  // A settled budget error resolves without throwing and its reply never went through onReplyStream,
  // so speak it here rather than leave the caller in silence.
  if (processService.terminalError) onReplyStream(reply);
  return reply;
}

export const config = {
  api: {
    externalResolver: true,
    bodyParser: { sizeLimit: '256kb' },
  },
};

// Anonymous by design (the voice session token is the auth), so it opts into the network block itself.
const ipGatedApi = baseApi({ auth: false }).use(checkBlockedIP({ surface: 'app' }));

const handler = ipGatedApi.post(async (req, res) => {
  const body = req.body as OpenAIChatRequest & {
    elevenlabs_extra_body?: { b4m_session?: unknown };
  };

  // Every voice turn carries the signed session token minted by POST /sessions,
  // forwarded by the browser as `customLlmExtraBody.b4m_session`. We authenticate
  // the turn solely by verifying that token - its claims (userId, sessionId, ...)
  // are the trusted identity. The route is intentionally `auth: false` because
  // ElevenLabs can't present a B4M JWT in the Authorization header; the session
  // token is the auth instead. A missing/forged/expired token is rejected, so
  // reaching the proxy URL grants nothing without a valid token.
  const rawToken = body.elevenlabs_extra_body?.b4m_session;
  if (typeof rawToken !== 'string' || !rawToken) {
    req.logger.warn('[voice-v2/llm-proxy] missing b4m_session token');
    return res.status(401).json({ error: 'Missing b4m_session token' });
  }

  let sessionCtx: VoiceSessionContext;
  try {
    sessionCtx = verifyVoiceSessionToken(rawToken);
  } catch (err) {
    req.logger.warn({ err }, '[voice-v2/llm-proxy] invalid or expired b4m_session token');
    return res.status(401).json({ error: 'Invalid or expired b4m_session token' });
  }

  const model = sessionCtx.reasoningModelId;

  // ElevenLabs calling the proxy with a valid token is server-to-server proof the call is live
  // (it also calls on user silence), so it marks the hold connected without trusting the browser.
  // The same write gates the turn: a token naming a hold that is no longer open (ended, swept, or
  // settled by a newer call) gets a 402 so ElevenLabs ends the call instead of talking for free.
  // A turn is also refused when the token names no hold, when the hold's window
  // (VOICE_SESSION_TOKEN_TTL_SECONDS from its start) has passed, or when the write fails: any of
  // them would otherwise serve turns the reserve does not cover.
  const holdStartedAt = sessionCtx.voiceHoldStartedAt ? new Date(sessionCtx.voiceHoldStartedAt) : null;
  const now = new Date();
  const holdOpen =
    holdStartedAt !== null &&
    now.getTime() <= voiceSessionTokenExpiresAtMs(holdStartedAt) &&
    (await sessionRepository.recordVoiceActivity(sessionCtx.sessionId, now, holdStartedAt).catch((err: unknown) => {
      req.logger.warn({ err }, '[voice-v2/llm-proxy] failed to record voice activity');
      return false;
    }));
  if (!holdOpen) {
    req.logger.info({ sessionId: sessionCtx.sessionId }, '[voice-v2/llm-proxy] voice hold is no longer open');
    return res.status(402).json({ error: 'Voice session has ended', request_id: req.requestId });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Early bail: no fresh user input this turn (silence / "..." marker). Speak a
  // static re-engagement line so the agent checks the user is still there -
  // no ChatCompletionProcess run, no quest created.
  const message = currentTurnUserMessage(body.messages);
  if (!message) {
    writeStaticCompletion(res, model, '');
    return;
  }
  // Drop duplicate turns: if the original quest for this exact prompt is still
  // running, ElevenLabs is retrying a slow turn - don't create a second quest.
  // Close the stream with no spoken content; the original turn's stream speaks.
  // If that turn already started a video job the original stream may be gone, so
  // say so instead of staying silent - and never start a second billed job.
  const duplicate = await findDuplicateTurn(sessionCtx.sessionId, message);
  if (duplicate) {
    req.logger.info({ sessionId: sessionCtx.sessionId, duplicate }, '[voice-v2/llm-proxy] duplicate turn - skipping');
    writeStaticCompletion(
      res,
      model,
      duplicate === 'video-started' ? 'Your video is already being made and will show up in the chat.' : ''
    );
    return;
  }

  const systemPrompt = extractSystemPrompt(body.messages);

  // Offer ElevenLabs' system tools (end_call, ...) to the model as real function
  // tools. The model decides using their own descriptions; calls it makes are
  // captured here and echoed back as native OpenAI tool_calls below. ElevenLabs
  // only sends these when configured on the agent, so this is empty otherwise.
  const collectedToolCalls: CapturedToolCall[] = [];
  const clientTools = buildClientToolPassthrough(body, call => collectedToolCalls.push(call));

  const chunkId = `chatcmpl-v2-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);

  // Emit an ElevenLabs "buffer words" chunk as the initial chunk of every turn so
  // the agent speaks a brief filler while the pipeline runs (cold-start work, RAG,
  // tools) before any real reply tokens land. Out-of-band - the emit deliberately
  // does NOT advance `sent`, so the actual reply diff stays clean.
  emitInitialBuffer(phrase => res.write(openAiSseChunk({ id: chunkId, model, created, contentDelta: phrase })));

  // Relay streamed reply updates as OpenAI SSE token deltas. ChatCompletionProcess
  // hands us the full accumulated reply each tick; we strip any <think> reasoning
  // (never spoken), diff against what we've already written, and emit only the new
  // tail. Streaming the first tokens early keeps ElevenLabs under its
  // time-to-first-token timeout.
  let sent = '';
  const writeDelta = (fullReply: string) => {
    if (res.writableEnded) return;
    const visible = stripSpokenThinking(fullReply);
    const delta = diffAccumulated(sent, visible);
    if (delta) res.write(openAiSseChunk({ id: chunkId, model, created, contentDelta: delta }));
    // Advance the baseline to the longest text seen so we never re-emit
    // already-spoken content and a post-reasoning extension diffs cleanly.
    if (visible.length > sent.length) sent = visible;
  };

  // If ElevenLabs drops the connection mid-turn (user hangs up, barge-in, or its
  // time-to-first-token timer fires), stop the in-flight quest so the pipeline
  // doesn't keep running tools / burning tokens with no consumer. The pipeline's
  // cancellation watcher aborts the underlying request when the quest goes 'stopped'.
  let questId: string | null = null;
  let settled = false;
  res.on('close', () => {
    if (settled || !questId) return;
    req.logger.warn(
      { sessionId: sessionCtx.sessionId, questId },
      '[voice-v2/llm-proxy] client disconnected — stopping turn'
    );
    void questRepository.markStopped(questId).catch(() => {});
  });

  try {
    await runFullPipeline(
      sessionCtx,
      message,
      systemPrompt,
      req.logger,
      writeDelta,
      id => {
        questId = id;
      },
      clientTools
    );
    if (!res.writableEnded) {
      // Call ElevenLabs system tools (e.g end_call)
      if (collectedToolCalls.length > 0) {
        req.logger.info(
          { sessionId: sessionCtx.sessionId, tools: collectedToolCalls.map(c => c.name) },
          '[voice-v2/llm-proxy] model invoked client tools'
        );
        res.write(
          openAiSseChunk({
            id: chunkId,
            model,
            created,
            toolCallDeltas: collectedToolCalls.map((call, index) => ({
              index,
              id: `${chunkId}-tc-${index}`,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
            finishReason: 'tool_calls',
          })
        );
      } else {
        res.write(openAiSseChunk({ id: chunkId, model, created, finishReason: 'stop' }));
      }
      res.write(openAiSseDone());
      res.end();
    }
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted') || err.message === 'Aborted');
    if (isAbort) {
      req.logger.debug({ err }, '[voice-v2/llm-proxy] request aborted (client disconnect)');
      if (!res.writableEnded) res.end();
      return;
    }
    // Flat strings next to `err`: the alert sink prints each field with `${value}`, which turned
    // the nested error object into `[object Object]`.
    req.logger.error(
      {
        err,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorCause: describeErrorCause(err),
      },
      '[voice-v2/llm-proxy] full pipeline failed'
    );
    try {
      if (res.writableEnded) return;
      // Only speak the fallback if nothing was streamed yet - otherwise the agent
      // already started talking and we just close cleanly.
      if (!sent) {
        res.write(
          openAiSseChunk({
            id: chunkId,
            model,
            created,
            contentDelta: "Sorry, I couldn't process that request. Please try again.",
          })
        );
      }
      res.write(openAiSseChunk({ id: chunkId, model, created, finishReason: 'stop' }));
      res.write(openAiSseDone());
      res.end();
    } catch {
      // already closed
    }
  } finally {
    // The turn finished on its own - a subsequent connection 'close' is the normal
    // end of the stream, not a client abort, so the disconnect handler must no-op.
    settled = true;
  }
});

export default handler;
