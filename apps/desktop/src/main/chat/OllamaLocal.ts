import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { modelBlobsOf, type FetchLike } from '@bike4mind/local-models';
import {
  localBackend,
  localModelId,
  parseLocalModelId,
  type ChatModelOption,
  type ContextNoticeKind,
} from '@shared/chat';
import {
  AUTO_LOCAL_CONTEXT,
  LOCAL_CONTEXT_SIZES,
  contextSizeLabel,
  type LocalContextFit,
  type LocalContextSetting,
  type ModelContextSetting,
} from '@shared/localContextSetting';
import { MAX_DRAFT_TOKENS, type ModelLoadOffer, type ModelLoadSettings } from '@shared/modelSettings';
import type { QuantizedKvCacheType } from '@shared/modelServers';
import type { CompletionMessage, CompletionRequest } from './completions';
import { configuredNumCtx, positiveTokenCount } from './localChatContext';
import { draftFactsOf, draftTokensOf, ollamaDraft, ollamaLoadFields } from './loadOptions';
import {
  autoLimit,
  chatContextTokens,
  ContextOverflowError,
  estimateTokens,
  fitToContext,
  grownContext,
  LOCAL_CONTEXT_TARGET_TOKENS,
  loadsInMemory,
  overflowTokens,
  type ContextGrowth,
  type LocalModelFootprint,
  type OllamaMessage,
} from './localContext';
import { ServerCredentialsError, ServerForbiddenError } from '../modelServers/errors';
import { ollamaControls } from './modelControls';
import type { CompletionStreamEvent } from './streamEvents';
import { createThinkFilter, type ThinkSplit } from './thinkFilter';
import { ollamaRate } from './tokenRate';

export const OLLAMA_RUNTIME_ID = 'ollama';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 1_000;
/** A server across a network answers short calls slower than the daemon on this computer. */
const REMOTE_TIMEOUT_MS = 8_000;
/** A busy daemon can take seconds to answer /api/show; a turn waits for it rather than failing. */
const TURN_INSPECT_TIMEOUT_MS = 10_000;
const INSPECT_RETRY_MS = 5_000;
const INSPECT_RETRY_MAX_MS = 300_000;
const MAX_TRIM_RETRIES = 3;
const REASONING_ALLOWANCE_TOKENS = 2048;
const EMPTY_REPLY_RETRIES = 1;
const remoteFields = { remote_host: z.string().optional(), remote_model: z.string().optional() };
const tagsSchema = z.object({
  models: z.array(
    z.object({ name: z.string().min(1), size: z.number().optional(), digest: z.string().optional(), ...remoteFields })
  ),
});
const showSchema = z.object({
  capabilities: z.array(z.string()),
  model_info: z.record(z.string(), z.unknown()).nullable().optional(),
  parameters: z.string().optional(),
  template: z.string().optional().catch(undefined),
  modelfile: z.string().optional().catch(undefined),
  /** The `think` values the model honors (booleans or effort names); absent when Ollama does not know. */
  thinking: z
    .object({ values: z.array(z.unknown()) })
    .optional()
    .catch(undefined),
  ...remoteFields,
});

/** The model is no longer installed; ChatService then rereads the local list on the next send. */
export class LocalModelRemovedError extends Error {
  constructor() {
    super('This model was removed from Ollama. Pick another model.');
    this.name = 'LocalModelRemovedError';
  }
}

async function ollamaError(response: Response, server?: RemoteOllama): Promise<Error> {
  if (server && response.status === 401) return new ServerCredentialsError(server.label, server.hasCredentials());
  if (server && response.status === 403) return new ServerForbiddenError(server.label);
  const message = await httpError(response, server?.label ?? 'Ollama');
  // Ollama answers "model '...' not found" once the model is deleted, e.g. from the Models screen.
  if (response.status === 404 && /model .* not found/i.test(message)) return new LocalModelRemovedError();
  return new Error(message);
}

function usesRemoteModel(model: { remote_host?: string; remote_model?: string }): boolean {
  return !!(model.remote_host?.trim() || model.remote_model?.trim());
}

/**
 * How a request with thinking off is sent:
 * - `think-false`: the template honors it (false among Ollama's values, or no values reported
 *   and no hard-coded opener).
 * - `no-think-switch`: Qwen3's documented soft switch on the user turn, `think` left out.
 * - `lowest-effort`: an effort-only model (gpt-oss) gets its lowest level.
 * - `always-thinks`: Off cannot take effect; `think` is left out so Ollama still splits the
 *   reasoning from the reply (think:false would turn that parser off and leak it).
 */
type ThinkingOffMode = 'think-false' | 'no-think-switch' | 'lowest-effort' | 'always-thinks';

function thinkingOffMode(inspection: Inspection): ThinkingOffMode {
  const values = inspection.thinking?.values;
  if (!values) return opensThinkBlock(inspection.template) ? 'always-thinks' : 'think-false';
  if (values.includes(false)) return 'think-false';
  if (isLegacyQwen3Hybrid(inspection, values)) return 'no-think-switch';
  return values.some(value => typeof value === 'string') ? 'lowest-effort' : 'always-thinks';
}

/**
 * Whether the generation prompt ends in a literal `<think>` with no branch that turns it off,
 * Go (`.Think`) or Jinja (`enable_thinking`). Ollama reports no `thinking` values for most such
 * templates, only for the few it recognizes by digest.
 */
function opensThinkBlock(template: string | undefined): boolean {
  if (!template || /\.Think\b|enable_thinking/.test(template)) return false;
  return /<think>(?:\s|\\n|['"+])*(?:-?\}\}\s*)?\{[{%]-?\s*end(?:if)?\b/.test(template);
}

/**
 * The hybrid Qwen3 release under Ollama's older Qwen3 template (values exactly [true]); it obeys
 * `/no_think`. Thinking-2507, R1-Qwen3 and Coder share the architecture but not this template.
 */
function isLegacyQwen3Hybrid(inspection: Inspection, values: unknown[]): boolean {
  const architecture = inspection.model_info?.['general.architecture'];
  return (architecture === 'qwen3' || architecture === 'qwen3moe') && values.length === 1 && values[0] === true;
}

/** On the last user prompt only, so switching thinking mid-conversation changes just the tail. */
function withNoThinkSwitch(messages: OllamaMessage[]): OllamaMessage[] {
  const prompts = messages.flatMap((message, index) =>
    message.role === 'user' && !message.continuesTurn ? [index] : []
  );
  const last = prompts.at(-1) ?? messages.findLastIndex(message => message.role === 'user');
  return messages.map((message, index) =>
    index === last ? { ...message, content: message.content ? `${message.content} /no_think` : '/no_think' } : message
  );
}

function thinkField(
  inspection: Inspection,
  thinking: boolean | undefined,
  effort: string | undefined
): { think?: boolean | string } {
  if (thinking === undefined || !inspection.capabilities.includes('thinking')) return {};
  // A level the template names (gpt-oss: low, medium, high) is sent as that level.
  if (thinking && effort && inspection.thinking?.values.includes(effort)) return { think: effort };
  if (thinking) return { think: true };
  switch (thinkingOffMode(inspection)) {
    case 'think-false':
      return { think: false };
    case 'lowest-effort':
      return { think: inspection.thinking?.values.find(value => typeof value === 'string') as string };
    default:
      return {};
  }
}

/** A conversation's sampling overrides as Ollama `options`; an untouched one is left to the Modelfile. */
function ollamaSampling(generation: CompletionRequest['generation']): Record<string, number> {
  if (!generation) return {};
  return {
    ...(generation.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation.topP !== undefined ? { top_p: generation.topP } : {}),
    ...(generation.topK !== undefined ? { top_k: generation.topK } : {}),
    ...(generation.minP !== undefined ? { min_p: generation.minP } : {}),
    ...(generation.repeatPenalty !== undefined ? { repeat_penalty: generation.repeatPenalty } : {}),
    ...(generation.presencePenalty !== undefined ? { presence_penalty: generation.presencePenalty } : {}),
  };
}

/**
 * For a template that prefills `<think>` but that Ollama runs no reasoning parser for (no
 * thinking capability), splits the raw reply so the reasoning never reaches the answer.
 */
function splitPrefilledReasoning(onEvent: (event: CompletionStreamEvent) => void): typeof onEvent {
  const filter = createThinkFilter({ startInReasoning: true });
  const forward = ({ text, reasoning }: ThinkSplit) => {
    // A literal opener in the reasoning would otherwise nest and hide the reply downstream.
    if (reasoning) onEvent({ type: 'content', text: `<think>${reasoning.replaceAll('<think>', '')}</think>` });
    if (text) onEvent({ type: 'content', text });
  };
  // emitFrame sends reply text on events of its own, apart from usage and the stop reason.
  return event => {
    if (event.type === 'content' && event.text) return forward(filter.push(event.text));
    if (event.type === 'content' && event.stopReason !== undefined) forward(filter.flush());
    onEvent(event);
  };
}

const CHAT_URL = `${OLLAMA_URL}/api/chat` as const;

/** Typed to the chat URL alone, so the 1 s calls in json() cannot be routed through it. */
export type ChatFetch = (url: typeof CHAT_URL, init: RequestInit) => Promise<Response>;

/** What OllamaLocal already read about a model from `/api/tags` and `/api/show`. */
export interface LocalModelFacts {
  name: string;
  modelInfo?: Record<string, unknown>;
  /** `/api/show`'s Modelfile, whose FROM lines name the projector blobs. */
  modelfile?: string;
  sizeBytes?: number;
  digest?: string;
}

/** Without one, every model runs at Auto's 16K floor. Fields it cannot measure are null. */
export interface LocalContextSizing {
  setting(): Promise<LocalContextSetting>;
  /** Waits for the hardware probe and any inspection still running. */
  footprint(facts: LocalModelFacts): Promise<LocalModelFootprint>;
  /** What is known now, without waiting; starts whatever is missing. */
  cachedFootprint(facts: LocalModelFacts): LocalModelFootprint;
  /** After the Settings choice changes: read every model's shape again. */
  forget?(): void;
  /** The daemon's OLLAMA_KV_CACHE_TYPE as entered in Settings; undefined is f16. */
  kvCacheType?(): QuantizedKvCacheType | undefined;
}

type Inspection = z.infer<typeof showSchema>;
type TagRow = z.infer<typeof tagsSchema>['models'][number];

const UNMEASURED: LocalModelFootprint = { arch: null, weightsBytes: null, hardware: null };
const GROWTH_HINTS: Record<Exclude<ContextGrowth, { tokens: number }>['reason'], string> = {
  'model-limit': ' That is the most this model supports.',
  memory: " A larger context would not fit this computer's memory.",
  unmeasured:
    " Desktop could not measure this model's memory use, so it did not enlarge the context; Settings can set a larger one.",
};
const SLOWER_HINT = ' Part of the model now runs from system memory, so replies will be slower.';
const OWN_FIXED_HINT = " The model's Settings on the Models screen can give it a larger context.";
const OWN_CAP_HINT = " That is the most the model's Settings on the Models screen allow.";

/** A model's load settings, read strictly on every request so a failed read never becomes cached defaults. */
export type LoadSettingsReader = (modelId: string) => Promise<ModelLoadSettings>;

/** A saved Ollama server on another machine; see main/modelServers. */
export interface RemoteOllama {
  runtimeId: string;
  baseUrl: string;
  label: string;
  /** Adds the server's credentials and applies its transport rules; see createServerFetch. */
  fetch: FetchLike;
  hasCredentials(): boolean;
  /** Removes the server's credential from text it sent, such as an error inside a streamed reply. */
  redact: (text: string, response: Response) => string;
  /** The server's OLLAMA_KV_CACHE_TYPE as entered in Settings; undefined is f16. */
  kvCacheType?(): QuantizedKvCacheType | undefined;
}

export class OllamaLocal {
  private listed: ChatModelOption[] = [];
  private readonly runtimeId: string;
  /** Conversation to the model it was last told has no tool support; cleared once a model with tools runs. */
  private readonly toldNoTools = new Map<string, string>();

  /**
   * Main passes Electron's net.fetch: Node's fetch gives up after five minutes without response
   * headers, and Ollama sends none until prefill ends, which takes that long for a CPU-only model.
   * Only chat uses it: Chromium allows 6 sockets per host and each open stream holds one, so the
   * short calls stay on Node's fetch, which a full pool cannot starve.
   *
   * With `server`, every call goes to that server through its own fetch instead, and its models are
   * keyed by its runtime id. Sizing measures this computer, so a server is not given one.
   */
  constructor(
    private readonly chatFetch: ChatFetch = (url, init) => globalThis.fetch(url, init),
    private readonly sizing?: LocalContextSizing,
    private readonly server?: RemoteOllama,
    private readonly loadSettings: LoadSettingsReader = async () => ({})
  ) {
    this.runtimeId = server?.runtimeId ?? OLLAMA_RUNTIME_ID;
  }

  async models(): Promise<ChatModelOption[]> {
    try {
      return await this.listModels();
    } catch (err) {
      // A daemon that is not running has no models; a slow or failing one keeps its last list.
      if (refused(err)) this.listed = [];
      return this.listed;
    }
  }

  /** `models`, except a failed `/api/tags` rejects, so a caller can tell a server that is down from one with no models. */
  async listModels(): Promise<ChatModelOption[]> {
    const rows = await this.tags();
    this.listed = (await Promise.all(rows.map(row => this.model(row.name)))).filter(
      (model): model is ChatModelOption => model !== null
    );
    return this.listed;
  }

  private key(name: string): string {
    return this.server ? `${this.runtimeId}\n${name}` : name;
  }

  private chatPost(init: RequestInit): Promise<Response> {
    return this.server ? this.server.fetch(`${this.server.baseUrl}/api/chat`, init) : this.chatFetch(CHAT_URL, init);
  }

  /**
   * The num_ctx requests to this model are sent with; ChatService compacts and sizes summaries
   * against it. Asks Ollama when not cached.
   */
  async contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    const known = contextByModel.get(modelId);
    if (known !== undefined) return known;
    const name = ollamaModelName(modelId, this.runtimeId);
    return this.resolveContext(modelId, showSchema.parse(await this.json('/api/show', { name }, signal)));
  }

  /**
   * The local models each Settings size may not fit, so Settings can say so beside it. A model with a
   * context of its own is left out, since the Settings choice does not reach it.
   */
  async contextFit(): Promise<LocalContextFit> {
    const sizing = this.sizing;
    const rows = sizing ? await this.tags().catch(() => null) : null;
    if (!sizing || !rows) return {};
    const fit: LocalContextFit = {};
    for (const row of rows) {
      const inspection = await this.chatInspection(row.name);
      if (!inspection) continue;
      // A model whose settings cannot be read may have a context of its own, so it gets no fit note.
      const load = await this.load(localModelId(this.runtimeId, row.name)).catch(() => null);
      if (!load || load.context) continue;
      const footprint = await this.footprint(row.name, inspection, load);
      const { limit } = contextBounds(inspection);
      for (const size of LOCAL_CONTEXT_SIZES)
        if (loadsInMemory(footprint, Math.min(size, limit ?? size)) === false) (fit[size] ??= []).push(row.name);
    }
    return fit;
  }

  async stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    /** Called with how many of the oldest messages were left out because the prompt overflowed. */
    onTrimmed?: (dropped: number) => void,
    /** Called when Auto changed this model's context in a way the user should hear about. */
    onNotice?: (message: string, kind?: ContextNoticeKind) => void
  ): Promise<void> {
    const model = ollamaModelName(request.model, this.runtimeId);
    const inspection = showSchema.parse(await this.json('/api/show', { name: model }, signal, TURN_INSPECT_TIMEOUT_MS));
    // A localhost daemon can proxy cloud models, including aliases without a cloud suffix.
    // Inspect again before sending private messages, even when discovery was cached.
    if (usesRemoteModel(inspection)) throw new Error('Cloud-backed Ollama models cannot be used as local models.');
    if (!inspection.capabilities.includes('completion')) throw new Error('This Ollama model cannot answer chat.');
    knownInspections.set(this.key(model), inspection);
    const settings = await this.requestSettings(request.model, inspection);
    let numCtx = settings.numCtx;
    const load = ollamaLoadFields(settings.load, draftFactsOf(inspection));
    const canThink = inspection.capabilities.includes('thinking');
    const prefilled = !canThink && opensThinkBlock(inspection.template);
    const offMode = canThink ? thinkingOffMode(inspection) : undefined;
    // A short budget (titles, suggestions) is meant for the answer; reasoning the model does
    // anyway would otherwise use it all up and leave the answer empty.
    const reasonsAnyway =
      prefilled || (request.thinking === false && (offMode === 'always-thinks' || offMode === 'lowest-effort'));
    const maxTokens =
      request.maxTokens && reasonsAnyway ? request.maxTokens + REASONING_ALLOWANCE_TOKENS : request.maxTokens;
    const messages =
      request.thinking === false && offMode === 'no-think-switch'
        ? withNoThinkSwitch(toMessages(request.messages))
        : toMessages(request.messages);
    // Ollama refuses tools for a model without the capability; the list may not have known it yet.
    const canUseTools = inspection.capabilities.includes('tools');
    const tools = canUseTools
      ? (request.tools ?? []).map(tool => ({ type: 'function', function: tool.toolSchema }))
      : [];
    const offeredTools = request.toolsUnsupported === true || (request.tools?.length ?? 0) > 0;
    // A switch through a hosted model or another server's Ollama keeps the told state; the picker's "No tools" label still shows.
    if (canUseTools && request.sessionId) {
      this.toldNoTools.delete(request.sessionId);
    } else if (offeredTools && onNotice && request.sessionId && this.toldNoTools.get(request.sessionId) !== model) {
      this.toldNoTools.set(request.sessionId, model);
      onNotice(noToolsNotice(model), 'no-tools');
    }
    const post = (fitted: OllamaMessage[]) => {
      // Another conversation may have grown the model, or a load failure lowered it, since this turn began.
      numCtx = contextByModel.get(request.model) ?? numCtx;
      return this.chatPost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: fitted.map(({ continuesTurn: _continuesTurn, ...message }) => message),
          // Ollama's own truncation and its context shift (once prompt plus reply reach num_ctx) both
          // keep the first few tokens and the tail, cutting the system prompt. With shift off the
          // reply stops at num_ctx instead, as done_reason 'length' (a visible max_tokens stop).
          truncate: false,
          shift: false,
          ...load.keepAlive,
          ...thinkField(inspection, request.thinking, request.reasoningEffort),
          options: {
            num_ctx: numCtx,
            ...load.options,
            ...(maxTokens ? { num_predict: maxTokens } : {}),
            ...ollamaSampling(request.generation),
          },
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    };
    let fellBack = false;
    // An explicit num_ctx turns off Ollama's own step-down when a load runs out of memory.
    const send = async (fitted: OllamaMessage[]) => {
      const reply = await post(fitted);
      if (reply.ok) loadedByModel.set(request.model, numCtx);
      if (fellBack || !(await failedToLoad(reply))) return reply;
      fellBack = true;
      const tried = numCtx;
      const floor = await this.fallBack(request.model, inspection, tried);
      if (floor === undefined) return reply;
      onNotice?.(
        `This model could not load with a ${shortSize(tried)}-token context, so Desktop runs it at ${shortSize(floor)} for now.`,
        'context-size'
      );
      return post(fitted);
    };
    // Everything goes out first: auto-compaction works from the measured size and must get its
    // chance before turns are dropped, which happens only once Ollama refuses the prompt.
    let sent = messages;
    let response = await send(sent);
    let measured = await refusedSize(response);
    let hint = '';
    if (measured !== undefined) {
      const growth = await this.grow(request.model, inspection, measured, request.maxTokens, numCtx);
      hint = growth.hint;
      if (growth.tokens !== undefined) {
        numCtx = growth.tokens;
        if (growth.slower)
          onNotice?.(
            `This conversation now runs with a ${shortSize(numCtx)}-token context.${SLOWER_HINT}`,
            'context-size'
          );
        response = await send(sent);
        measured = await refusedSize(response);
      }
    }
    const whole = measured;
    let left = 0;
    for (let retry = 0; measured !== undefined; retry++) {
      numCtx = contextByModel.get(request.model) ?? numCtx;
      // Rescaled from each refusal: the dropped turns need not be as token-dense as the kept ones.
      const fit = fitToContext(sent, tools, numCtx, maxTokens, (1.1 * measured) / estimateTokens(sent, tools));
      if (fit.dropped === 0)
        throw new ContextOverflowError(
          `This turn and Desktop's instructions take ${measured} tokens, more than the ${numCtx} this model is run with.${hint}`,
          measured,
          numCtx
        );
      if (retry === MAX_TRIM_RETRIES)
        throw new ContextOverflowError(
          `This conversation still takes ${measured} tokens after leaving out its ${left} oldest messages, more than the ${numCtx} this model is run with. Run /compact to summarise it.`,
          measured,
          numCtx
        );
      left += fit.visible;
      sent = fit.messages;
      response = await send(sent);
      measured = await refusedSize(response);
    }
    if (!response.ok || !response.body) throw await ollamaError(response, this.server);
    if (left > 0) onTrimmed?.(left);
    // Recorded now, not only on the done frame, so a reply stopped early still makes the next turn compact.
    if (whole !== undefined) onEvent({ type: 'content', usage: { inputTokens: whole } });
    // Report the whole conversation's size, so the next turn compacts instead of trimming again.
    const report: typeof onEvent =
      whole === undefined
        ? onEvent
        : event =>
            onEvent(
              event.type === 'content' && event.usage
                ? { ...event, usage: { ...event.usage, inputTokens: whole } }
                : event
            );
    // Small models sometimes end their turn before saying anything; that is asked again once, then reported.
    let body = response.body;
    for (let attempt = 0; ; attempt++) {
      // A fresh splitter per attempt: its state must not carry over from an abandoned reply.
      const sink = prefilled ? splitPrefilledReasoning(report) : report;
      const server = this.server;
      if (await readReply(body, sink, server ? text => server.redact(text, response) : undefined)) return;
      if (attempt === EMPTY_REPLY_RETRIES)
        throw new Error(
          `${model} ended its reply without writing anything. Send the message again or pick a larger model.`
        );
      const again = await send(sent);
      if (!again.ok || !again.body) throw await ollamaError(again, this.server);
      response = again;
      body = again.body;
    }
  }

  /**
   * Sized on a model's first request, then kept for the app run so a late answer never reloads it;
   * a footprint missing the weights or the machine (a slow daemon or probe) is sized again next time.
   */
  private async resolveContext(modelId: string, inspection: Inspection): Promise<number> {
    return (await this.sizedContext(modelId, inspection)).tokens;
  }

  /** The context with the load settings it was sized from, when it read or was given them, so a request sends the two together. */
  private async sizedContext(
    modelId: string,
    inspection: Inspection,
    snapshot?: { load: ModelLoadSettings; generation: string },
    attempt = 1
  ): Promise<{ tokens: number; load?: ModelLoadSettings }> {
    const known = contextByModel.get(modelId);
    if (known !== undefined) return { tokens: known, load: snapshot?.load };
    const generation = snapshot?.generation ?? sizingGenerationOf(modelId);
    const load = snapshot?.load ?? (await this.load(modelId));
    const setting = load.context ?? (await this.setting());
    const measured = setting.mode === 'auto' && !!this.sizing;
    const footprint = measured
      ? await this.footprint(ollamaModelName(modelId, this.runtimeId), inspection, load)
      : UNMEASURED;
    const stale = generation !== sizingGenerationOf(modelId);
    // Retried with a fresh read, not the snapshot; requestSettings re-checks the generation so its load matches.
    if (stale && attempt < SIZING_ATTEMPTS) return this.sizedContext(modelId, inspection, undefined, attempt + 1);
    const raced = contextByModel.get(modelId);
    if (raced !== undefined) return { tokens: raced, load };
    const { limit, configured } = contextBounds(inspection);
    const tokens = chatContextTokens({ setting, footprint, modelLimit: limit, configured });
    if (!stale && (!measured || (footprint.weightsBytes !== null && footprint.hardware !== null)))
      contextByModel.set(modelId, tokens);
    return { tokens, load };
  }

  private async requestSettings(
    modelId: string,
    inspection: Inspection
  ): Promise<{ numCtx: number; load: ModelLoadSettings }> {
    for (let attempt = 1; ; attempt++) {
      const generation = sizingGenerationOf(modelId);
      const load = await this.load(modelId);
      const sized = await this.sizedContext(modelId, inspection, { load, generation });
      // A save during either read invalidates the whole request's load settings together.
      if (generation === sizingGenerationOf(modelId) || attempt === SIZING_ATTEMPTS)
        return { numCtx: sized.tokens, load: sized.load ?? load };
    }
  }

  private async setting(): Promise<LocalContextSetting> {
    return (await this.sizing?.setting()) ?? AUTO_LOCAL_CONTEXT;
  }

  private load(modelId: string): Promise<ModelLoadSettings> {
    return this.loadSettings(modelId);
  }

  /** For listing and fit, which need not fail with the settings file: requests read it strictly. */
  private listedLoad(modelId: string): Promise<ModelLoadSettings> {
    return this.load(modelId).catch(() => ({}));
  }

  private async contextSetting(modelId: string): Promise<ModelContextSetting> {
    return (await this.load(modelId)).context ?? (await this.setting());
  }

  /** What fit plans for: the model's measured shape with the draft it runs, waiting for both. */
  private async footprint(name: string, inspection: Inspection, load: ModelLoadSettings): Promise<LocalModelFootprint> {
    if (!this.sizing) return UNMEASURED;
    const footprint = await this.sizing.footprint(await this.facts(name, inspection));
    return { ...footprint, draftMax: draftTokensOf(load, draftFactsOf(inspection)) };
  }

  private async sized(
    inspection: Inspection,
    footprint: LocalModelFootprint,
    load: ModelLoadSettings
  ): Promise<number> {
    const { limit, configured } = contextBounds(inspection);
    const setting = load.context ?? (await this.setting());
    return chatContextTokens({ setting, footprint, modelLimit: limit, configured });
  }

  /** Auto, after a load failed: the last size that loaded, else the 16K floor, once per app run; undefined when there is nothing lower to try. */
  private async fallBack(modelId: string, inspection: Inspection, current: number): Promise<number | undefined> {
    const generation = sizingGenerationOf(modelId);
    const setting = await this.contextSetting(modelId);
    const { limit } = contextBounds(inspection);
    const floor = Math.min(LOCAL_CONTEXT_TARGET_TOKENS, limit ?? LOCAL_CONTEXT_TARGET_TOKENS);
    const loaded = loadedByModel.get(modelId) ?? 0;
    const target = loaded < current ? Math.max(floor, loaded) : floor;
    if (setting.mode === 'fixed' || current <= target || generation !== sizingGenerationOf(modelId)) return undefined;
    failedLoads.add(modelId);
    contextByModel.set(modelId, target);
    return target;
  }

  /**
   * Under Auto, grows the model so a prompt of `tokens` fits, as an overflow would; the new num_ctx, or
   * undefined when it cannot grow. ChatService asks before compacting a conversation near its window.
   */
  async growFor(modelId: string, tokens: number): Promise<number | undefined> {
    const name = ollamaModelName(modelId, this.runtimeId);
    const inspection = knownInspections.get(this.key(name)) ?? showSchema.parse(await this.json('/api/show', { name }));
    const current = await this.resolveContext(modelId, inspection);
    return (await this.grow(modelId, inspection, tokens, undefined, current)).tokens;
  }

  /** The load-time options this model takes, each size rated for `draftTokens` (undefined: the model's own). */
  async loadOffer(modelId: string, draftTokens?: number): Promise<ModelLoadOffer> {
    const name = ollamaModelName(modelId, this.runtimeId);
    const entered = this.server ? this.server.kvCacheType?.() : this.sizing?.kvCacheType?.();
    const kvCache: ModelLoadOffer['kvCache'] = { type: entered ?? 'f16' };
    const inspection = await this.chatInspection(name);
    if (!inspection) return { keepAlive: true, kvCache };
    const facts = draftFactsOf(inspection);
    const draft = ollamaDraft(facts);
    const footprint = await this.footprint(name, inspection, draftTokens === undefined ? {} : { draftTokens });
    const { limit, configured } = contextBounds(inspection);
    const sized = (setting: ModelContextSetting) =>
      chatContextTokens({ setting, footprint, modelLimit: limit, configured });
    // The first size past the trained length stays, clamped to it, so a 40K model can run at all of it.
    const sizes = LOCAL_CONTEXT_SIZES.filter(
      (size, index) => index === 0 || limit === undefined || size <= limit || LOCAL_CONTEXT_SIZES[index - 1] < limit
    );
    const measured = this.sizing !== undefined;
    return {
      context: {
        kind: 'ollama',
        settings: sized(await this.setting()),
        ...(measured ? { auto: sized(AUTO_LOCAL_CONTEXT) } : {}),
        ceiling: sized({ mode: 'fixed', tokens: LOCAL_CONTEXT_SIZES[LOCAL_CONTEXT_SIZES.length - 1] }),
        sizes: sizes.map(size => {
          const tokens = sized({ mode: 'fixed', tokens: size });
          const loads = loadsInMemory(footprint, tokens);
          return {
            size,
            tokens,
            autoTokens: sized({ mode: 'auto', maxTokens: size }),
            ...(loads !== undefined ? { loads } : {}),
          };
        }),
      },
      ...(draft ? { draft: { modelDefault: draft.modelDefault, max: MAX_DRAFT_TOKENS } } : {}),
      keepAlive: true,
      kvCache,
    };
  }

  /** Under Auto, the larger context a refused prompt needs when the model and memory hold it; else why not. */
  private async grow(
    modelId: string,
    inspection: Inspection,
    measured: number,
    maxTokens: number | undefined,
    current: number
  ): Promise<{ tokens?: number; slower?: boolean; hint: string }> {
    const generation = sizingGenerationOf(modelId);
    const load = await this.load(modelId);
    const setting = load.context ?? (await this.setting());
    const { limit } = contextBounds(inspection);
    if (setting.mode === 'fixed') {
      const larger = LOCAL_CONTEXT_SIZES.some(size => size > current) && (limit === undefined || current < limit);
      if (!larger) return { hint: '' };
      return { hint: load.context ? OWN_FIXED_HINT : ' Settings can give local models a larger context.' };
    }
    const footprint = await this.footprint(ollamaModelName(modelId, this.runtimeId), inspection, load);
    // Settings changed while this was measured: the new choice decides the size.
    if (generation !== sizingGenerationOf(modelId)) {
      const fresh = await this.resolveContext(modelId, inspection);
      return fresh > current ? { tokens: fresh, hint: '' } : { hint: '' };
    }
    // Another conversation may have grown it while this request was out.
    const other = contextByModel.get(modelId) ?? 0;
    if (failedLoads.has(modelId)) return other > current ? { tokens: other, hint: '' } : { hint: GROWTH_HINTS.memory };
    const ceiling = autoLimit(setting, footprint, limit);
    const growth = grownContext(footprint, measured, maxTokens, ceiling, current);
    if (growth.tokens === undefined) {
      if (other > current) return { tokens: other, hint: '' };
      const capped = growth.reason === 'model-limit' && ceiling !== autoLimit(AUTO_LOCAL_CONTEXT, footprint, limit);
      return { hint: capped ? OWN_CAP_HINT : GROWTH_HINTS[growth.reason] };
    }
    const tokens = Math.max(growth.tokens, other);
    contextByModel.set(modelId, tokens);
    return { tokens, slower: growth.slower && tokens === growth.tokens, hint: '' };
  }

  private async facts(name: string, inspection: Inspection): Promise<LocalModelFacts> {
    if (!tagFacts.has(this.key(name))) await this.tags().catch(() => null);
    return {
      name,
      modelInfo: inspection.model_info ?? undefined,
      modelfile: inspection.modelfile,
      ...tagFacts.get(this.key(name)),
    };
  }

  /** One `/api/tags` per refresh; a changed digest is a different model under the same name. */
  private async tags(): Promise<TagRow[]> {
    const { models } = tagsSchema.parse(await this.json('/api/tags'));
    const local = models.filter(row => !usesRemoteModel(row));
    for (const row of local) {
      const key = this.key(row.name);
      const known = tagFacts.get(key);
      if (known && known.digest !== row.digest) {
        forgetLocalContext(localModelId(this.runtimeId, row.name));
        knownInspections.delete(key);
        inspectRetries.delete(key);
      }
      tagFacts.set(key, {
        ...(row.size !== undefined && row.size > 0 ? { sizeBytes: row.size } : {}),
        ...(row.digest ? { digest: row.digest } : {}),
      });
    }
    return local;
  }

  /**
   * Null for a model that cannot answer chat or that a cloud host serves. When Ollama is too slow
   * or unreachable, the last answer for this digest, or undefined when there is none yet.
   */
  private async chatInspection(name: string): Promise<Inspection | null | undefined> {
    const key = this.key(name);
    const retry = inspectRetries.get(key);
    if (retry && Date.now() < retry.at) return knownInspections.get(key);
    let body: unknown;
    try {
      body = await this.json('/api/show', { name });
    } catch (err) {
      if (!unanswered(err)) return null;
      const delay = retry ? Math.min(retry.delay * 2, INSPECT_RETRY_MAX_MS) : INSPECT_RETRY_MS;
      inspectRetries.set(key, { at: Date.now() + delay, delay });
      return knownInspections.get(key);
    }
    inspectRetries.delete(key);
    const show = showSchema.safeParse(body);
    // Embedding-only models cannot answer /api/chat; an invalid answer is not a plain-text capability.
    if (!show.success || usesRemoteModel(show.data) || !show.data.capabilities.includes('completion')) {
      knownInspections.delete(key);
      return null;
    }
    knownInspections.set(key, show.data);
    return show.data;
  }

  private async model(name: string): Promise<ChatModelOption | null> {
    const inspection = await this.chatInspection(name);
    if (inspection === null) return null;
    // Not inspected yet: listed with the capability flags absent, which chat reads as tools on.
    const known = inspection ?? { capabilities: [] };
    const capabilities = inspection?.capabilities;
    const id = localModelId(this.runtimeId, name);
    // Advertised from what is known now; the context is settled on the model's first request.
    const load = await this.listedLoad(id);
    const draftMax = draftTokensOf(load, draftFactsOf(known));
    const footprint = this.sizing
      ? { ...this.sizing.cachedFootprint(await this.facts(name, known)), draftMax }
      : UNMEASURED;
    const contextWindow = contextByModel.get(id) ?? (await this.sized(known, footprint, load));
    const canThink = capabilities?.includes('thinking') === true;
    const controls = ollamaControls({
      inspected: inspection !== undefined,
      ...(inspection?.parameters !== undefined ? { parameters: inspection.parameters } : {}),
      ...(canThink && inspection?.thinking ? { thinkingValues: inspection.thinking.values } : {}),
      contextWindow,
      thinks: canThink,
    });
    const { modelBlob, adapterBlobs } = modelBlobsOf(inspection?.modelfile);
    return {
      id,
      name,
      backend: localBackend(this.runtimeId),
      ...(modelBlob ? { modelBlob } : {}),
      ...(adapterBlobs?.length ? { hasAdapter: true } : {}),
      ...(inspection?.parameters ? { modelParameters: inspection.parameters } : {}),
      ...(capabilities
        ? { supportsTools: capabilities.includes('tools'), supportsVision: capabilities.includes('vision') }
        : {}),
      contextWindow,
      ...(canThink
        ? {
            thinkingToggle: true,
            ...(thinkingOffMode(known) === 'always-thinks' ? { thinkingAlwaysOn: true } : {}),
          }
        : {}),
      // Stated once inspected, so a model that cannot think shows no effort menu that would do nothing.
      ...(capabilities ? { supportsReasoningEffort: controls.effort !== undefined } : {}),
      controls,
    };
  }

  private async json(path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const deadline = AbortSignal.timeout(timeoutMs ?? (this.server ? REMOTE_TIMEOUT_MS : TIMEOUT_MS));
    const fetchJson = this.server?.fetch ?? globalThis.fetch;
    const response = await fetchJson(`${this.server?.baseUrl ?? OLLAMA_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) throw await ollamaError(response, this.server);
    return response.json();
  }
}

type Block = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  source?: { data?: unknown };
};

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (block && typeof block === 'object' ? blockText((block as Block).text) : '')).join('');
}

/**
 * Maps the Anthropic-style blocks `ChatService` builds onto Ollama's chat format: tool calls on the
 * assistant message, one `role: 'tool'` message per result, screenshots in `images`.
 */
export function toMessages(messages: CompletionMessage[]): OllamaMessage[] {
  const toolNames = new Map<string, string>();
  return messages.flatMap(message => {
    const continues = message.continuesTurn ? { continuesTurn: true } : {};
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content, ...continues }];
    const blocks = message.content.filter((b): b is Block => !!b && typeof b === 'object');
    const text = blocks.map(block => (block.type === 'text' ? blockText(block.text) : '')).join('');
    const toolCalls = blocks.flatMap(block => {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return [];
      if (typeof block.id === 'string') toolNames.set(block.id, block.name);
      return [{ function: { name: block.name, arguments: block.input ?? {} } }];
    });
    const results = blocks.flatMap(block =>
      block.type === 'tool_result'
        ? [
            {
              role: 'tool',
              content: blockText(block.content),
              ...(typeof block.tool_use_id === 'string' && toolNames.has(block.tool_use_id)
                ? { tool_name: toolNames.get(block.tool_use_id) }
                : {}),
            },
          ]
        : []
    );
    const images = blocks.flatMap(block =>
      block.type === 'image' && typeof block.source?.data === 'string' ? [block.source.data] : []
    );
    const own =
      text || toolCalls.length > 0 || images.length > 0
        ? [
            {
              role: message.role,
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              ...(images.length > 0 ? { images } : {}),
              // Text riding on tool results is a note on them, not a new prompt.
              ...(results.length > 0 ? { continuesTurn: true } : continues),
            },
          ]
        : [];
    return [...results, ...own];
  });
}

/** False, with the final frame held back, when the model stopped without text, thinking or a tool call. */
async function readReply(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: CompletionStreamEvent) => void,
  redact: (text: string) => string = text => text
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let completed = false;
  let wrote = false;
  let held: CompletionStreamEvent | undefined;
  const forward = (event: CompletionStreamEvent) => {
    if (event.type === 'tool_use' || (event.type === 'content' && event.text)) wrote = true;
    if (!wrote && event.type === 'content' && event.stopReason === 'stop') held = event;
    else onEvent(event);
  };
  const consume = (line: string) => {
    if (line.trim()) completed = emitLine(line, forward, redact) || completed;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.write(Buffer.from(value));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    consume(pending + decoder.end());
    if (!completed) throw new Error('Ollama stream ended before the reply finished.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return held === undefined;
}

function emitLine(
  line: string,
  onEvent: (event: CompletionStreamEvent) => void,
  redact: (text: string) => string
): boolean {
  if (!line.trim()) return false;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new Error('Ollama returned a malformed stream frame.');
  }
  emitFrame(frame, onEvent, redact);
  return !!frame && typeof frame === 'object' && 'done' in frame && frame.done === true;
}

function emitFrame(
  frame: unknown,
  onEvent: (event: CompletionStreamEvent) => void,
  redact: (text: string) => string
): void {
  if (!frame || typeof frame !== 'object') return;
  const raw = frame as {
    done?: unknown;
    done_reason?: unknown;
    error?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    prompt_eval_duration?: unknown;
    eval_duration?: unknown;
    load_duration?: unknown;
    message?: { content?: unknown; thinking?: unknown; tool_calls?: unknown[] };
  };
  if (typeof raw.error === 'string') throw new Error(redact(raw.error));
  if (typeof raw.message?.thinking === 'string' && raw.message.thinking)
    onEvent({ type: 'content', text: `<think>${raw.message.thinking}</think>` });
  if (typeof raw.message?.content === 'string' && raw.message.content)
    onEvent({ type: 'content', text: raw.message.content });
  const tools = (raw.message?.tool_calls ?? []).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const call = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return typeof call.function?.name === 'string'
      ? [
          {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments ?? {}),
            ...(typeof call.id === 'string' ? { id: call.id } : {}),
          },
        ]
      : [];
  });
  if (tools.length > 0) onEvent({ type: 'tool_use', tools });
  if (raw.done === true) {
    const stopReason = raw.done_reason === 'length' ? 'max_tokens' : String(raw.done_reason ?? 'end_turn');
    const inputTokens = tokenCount(raw.prompt_eval_count);
    const outputTokens = tokenCount(raw.eval_count);
    const usage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
    const rate = ollamaRate(raw);
    onEvent({
      type: 'content',
      stopReason,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(rate ? { rate } : {}),
    });
  }
}

/** A missing or invalid measurement must stay unknown rather than becoming zero. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
    ? value
    : undefined;
}

async function httpError(response: Response, label: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const detail =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '';
  return `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`;
}

// 500 with one of these is the runner failing to load at this size; 503 and the rest are not a size problem.
const LOAD_FAILURE =
  /requires more system memory|unable to allocate|failed to (?:allocate|load)|out of memory|runner process has terminated/i;

async function failedToLoad(response: Response): Promise<boolean> {
  return response.status === 500 && LOAD_FAILURE.test(await response.clone().text());
}

function shortSize(tokens: number): string {
  return contextSizeLabel(tokens).replace(/ tokens$/, '');
}

async function refusedSize(response: Response): Promise<number | undefined> {
  return response.status === 400 ? overflowTokens(await response.clone().text()) : undefined;
}

function ollamaModelName(modelId: string, runtimeId: string): string {
  const parsed = parseLocalModelId(modelId);
  if (parsed?.runtimeId !== runtimeId) throw new Error('Invalid local model id.');
  return parsed.model;
}

/** Worded like the CLI's notice for a server model without tool support. */
export function noToolsNotice(model: string): string {
  return `${model} has no tool support, so this conversation runs without tools. Pick a model with tool support to use tools.`;
}

// Module-wide so every OllamaLocal instance (catalog, chat, tests) reads the same figure.
const contextByModel = new Map<string, number>();
/** Bumped by a Settings change, so sizing that started before it does not write its stale result. */
let sizingGeneration = 0;
/** Bumped for one model when its own load settings are saved, leaving other models' sizing alone. */
const modelGenerations = new Map<string, number>();
/** Saves arriving back to back during one request: past this many reads it goes out with the latest. */
const SIZING_ATTEMPTS = 5;
/** Models that failed to load above the floor this app run; Auto no longer grows them. */
const failedLoads = new Set<string>();
/** The num_ctx each model last answered at, which a failed larger load falls back to. */
const loadedByModel = new Map<string, number>();
/** These three are keyed by `key()`, so two servers with the same model name keep apart. */
const tagFacts = new Map<string, { sizeBytes?: number; digest?: string }>();
/** The last /api/show answer per model, kept so a slow daemon does not drop the model or its tools. */
const knownInspections = new Map<string, Inspection>();
const inspectRetries = new Map<string, { at: number; delay: number }>();

/** Nothing listening on Ollama's port: the daemon is not running. */
function refused(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = err.cause as { code?: unknown; errors?: { code?: unknown }[] } | undefined;
  return cause?.code === 'ECONNREFUSED' || !!cause?.errors?.some(inner => inner.code === 'ECONNREFUSED');
}

/** A timeout or a daemon that did not answer, as opposed to an answer saying the model is unusable. */
function unanswered(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'TimeoutError' || err.name === 'AbortError';
  return err instanceof TypeError;
}

/** The context requests to this model now go out with, once it has been settled. */
export function currentLocalContext(modelId: string): number | undefined {
  return contextByModel.get(modelId);
}

function forgetLocalContext(modelId: string): void {
  contextByModel.delete(modelId);
  failedLoads.delete(modelId);
  loadedByModel.delete(modelId);
}

/** After a model's own load settings change: it is sized again on its next request. */
export function forgetLocalContextOf(modelId: string): void {
  modelGenerations.set(modelId, (modelGenerations.get(modelId) ?? 0) + 1);
  forgetLocalContext(modelId);
}

function sizingGenerationOf(modelId: string): string {
  return `${sizingGeneration}:${modelGenerations.get(modelId) ?? 0}`;
}

/** After the Settings choice changes: every model is sized again on its next request. */
export function forgetLocalContexts(): void {
  sizingGeneration++;
  contextByModel.clear();
  failedLoads.clear();
  loadedByModel.clear();
  tagFacts.clear();
  knownInspections.clear();
  inspectRetries.clear();
}

/** The model's trained length and its Modelfile num_ctx, when they are valid counts. */
function contextBounds(inspection: Inspection): { limit: number | undefined; configured: number | undefined } {
  const architectureLimit = Object.entries(inspection.model_info ?? {}).find(
    ([key, value]) => key.endsWith('.context_length') && positiveTokenCount(value) !== undefined
  )?.[1];
  return { limit: positiveTokenCount(architectureLimit), configured: configuredNumCtx(inspection.parameters) };
}
