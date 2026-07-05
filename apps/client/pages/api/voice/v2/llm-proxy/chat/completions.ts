// Voice v2 LLM proxy - OpenAI Chat Completions-compatible streaming endpoint.
//
// Path mirrors ElevenLabs Conversational AI's Custom LLM URL convention:
// the agent's "Server URL" is configured to <host>/api/voice/v2/llm-proxy,
// and ElevenLabs appends "/chat/completions" when making the actual request,
// so the file lives at that suffix. This is the canonical (and only) location
// of the handler.
import { adminSettingsRepository, questRepository, userRepository } from '@bike4mind/database';
import {
  ChatCompletionFeature,
  ChatCompletionInvoke,
  ChatCompletionProcess,
  featureNames,
  type ToolDefinition,
} from '@bike4mind/services';
import { getSettingsMap, getSettingsValue, type IQueueService } from '@bike4mind/utils';
import { type Logger } from '@bike4mind/observability';
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
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';
import { verifyVoiceSessionToken, type VoiceSessionContext } from '@server/voice/voiceSessionToken';

// Built-in tools enabled for voice turns. Curated to ones that execute INLINE
// (no SQS/Lambda dispatch): web search, knowledge-base RAG, datetime,
// weather, and math. Deliberately excludes image generation, deep_research,
// jupyter/excel, and delegate_to_agent - those run out-of-process. `navigate_view`
// is auto-added by ChatCompletionProcess regardless.
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
// dispatching to SQS. Voice turns run fully in-process; nothing should enqueue,
// and if some path tries, this swallows it instead of hitting the queue.
const noopQueue: IQueueService = {
  async sendMessage() {
    return undefined;
  },
};

// How far back to look for an in-flight duplicate of this turn. ElevenLabs
// retries a slow voice turn within seconds, so a short window is plenty.
const DUPLICATE_LOOKBACK_MS = 60_000;

/**
 * True if this turn is already being processed. ElevenLabs retries a slow turn
 * (the proxy buffers the whole reply, and tools add latency), and each retry
 * would otherwise run a fresh ChatCompletionProcess and create a duplicate
 * quest. A quest is marked `running` the moment it's created and only flips to
 * `done` when the reply is ready, so a still-running quest in this session with
 * the same prompt means the original turn is mid-flight - drop the retry.
 */
async function isDuplicateInFlightTurn(sessionId: string, message: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - DUPLICATE_LOOKBACK_MS);
  const recent = await questRepository.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(sessionId, cutoff);
  return recent.some(q => q.status === 'running' && q.prompt === message);
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
  const user = await userRepository.findById(sessionCtx.userId);
  if (!user) throw new Error(`Voice v2: user not found for id ${sessionCtx.userId}`);

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['defaultEmbeddingModel'] }
  );
  const embeddingModel = getSettingsValue('defaultEmbeddingModel', settings);
  const organizationId = sessionCtx.organizationId || undefined;

  const chatCompletionOptions = {
    ...getDefaultChatCompletionOptions(),
    queue: noopQueue,
    tokenizer: getSharedTokenizer(logger),
    user,
    sessionId: sessionCtx.sessionId,
    gpcSignalDetected: false,
    features: new Map<featureNames, ChatCompletionFeature>(),
    logger,
    // Forward streamed reply updates to the SSE writer in the handler.
    onReplyStream,
    // No-op: we run process() inline in this request handler, so we deliberately
    // do NOT dispatch to the cliLlmHandler Lambda / EventBridge. invoke() requires
    // a callback (it throws if missing) but we want zero out-of-process work - the
    // whole completion happens synchronously here.
    invokeLambda: async () => {},
  };

  const invokeBody = {
    sessionId: sessionCtx.sessionId,
    message,
    historyCount: 10,
    fabFileIds: [],
    messageFileIds: [],
    organizationId,
    // stream:true so the model emits tokens incrementally - ChatCompletionProcess
    // fires onReplyStream on each chunk, and the proxy relays SSE deltas.
    params: { model: sessionCtx.reasoningModelId, max_tokens: 4096, stream: true },
    promptMeta: { session: { id: sessionCtx.sessionId, userId: sessionCtx.userId, organizationId } },
    enableArtifacts: false,
    // Enable the inline built-in tools (web search, RAG, etc.) plus any ElevenLabs
    // client tools for this turn. Without the builtins the agent can't search the
    // web. QuestMaster, Agents (subagent Lambda handoff), and Mementos (async
    // creation) stay off so the whole voice turn runs in-process - no separate
    // Lambda or SQS dispatch.
    tools: [...VOICE_BUILTIN_TOOLS, ...Object.keys(clientTools)],
    enableQuestMaster: false,
    enableMementos: false,
    enableAgents: false,
    // Inject the voice agent's system prompt (ElevenLabs-rendered, incl. per-user
    // override) at the top of the context so it drives the response persona.
    ...(systemPrompt ? { extraContextMessages: [{ role: 'system' as const, content: systemPrompt }] } : {}),
  };

  const invokeService = new ChatCompletionInvoke(chatCompletionOptions);
  const quest = await invokeService.invoke({ body: invokeBody, userId: sessionCtx.userId });
  if (!quest) throw new Error('Voice v2: failed to create quest');
  // Surface the quest id so the handler can stop it if the client disconnects.
  onQuestCreated(quest.id);

  const processService = new ChatCompletionProcess(chatCompletionOptions);
  await processService.process({
    body: {
      ...invokeBody,
      questId: quest.id,
      userId: sessionCtx.userId,
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
  });

  // process() mutates the quest in place. Use the last reply item (the visible
  // answer after any thinking reply) to match what onReplyStream forwarded.
  return quest.replies?.[quest.replies.length - 1] ?? quest.reply ?? '';
}

export const config = {
  api: {
    externalResolver: true,
    bodyParser: { sizeLimit: '256kb' },
  },
};

const handler = baseApi({ auth: false }).post(async (req, res) => {
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
  if (await isDuplicateInFlightTurn(sessionCtx.sessionId, message)) {
    req.logger.info({ sessionId: sessionCtx.sessionId }, '[voice-v2/llm-proxy] duplicate in-flight turn — skipping');
    writeStaticCompletion(res, model, '');
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
    req.logger.error({ err }, '[voice-v2/llm-proxy] full pipeline failed');
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
