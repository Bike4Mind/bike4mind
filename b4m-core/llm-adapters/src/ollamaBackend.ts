import {
  CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS,
  IMessage,
  isUserInitiatedAbort,
  ModelBackend,
  PermissionDeniedError,
  type MessageContentObject,
  type ModelInfo,
} from '@bike4mind/common';
import { stripToolDependentMessages } from './toolPairingUtils';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  ICompletionBackend,
  ICompletionOptions,
  ICompletionOptionTools,
} from './backend';
import { Ollama, Message as OllamaMessage, ModelResponse, Options as OllamaOptions, Tool, ToolCall } from 'ollama';
import { ILogger, Logger } from '@bike4mind/observability';
import { Agent } from 'undici';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { executeToolsBatch } from './executeToolsBatch';
import { normalizeOllamaDoneReason } from './stopReason';

/** A tool call normalized across native (message.tool_calls) and content-embedded forms. */
interface NormalizedToolCall {
  name: string;
  /** JSON-stringified arguments. */
  arguments: string;
  id: string;
}

export class OllamaBackend implements ICompletionBackend {
  private _host: string;
  private _api: Ollama;
  private _logger: ILogger;
  private _clientHost: string;
  private _clientHeaders: Record<string, string>;
  private _agent: Agent;
  public currentModel: string = '';

  constructor(host?: string, logger?: ILogger) {
    this._logger = logger ?? new Logger();
    this._host = host ?? 'http://localhost:11434';
    const url = new URL(this._host);
    const headers: Record<string, string> = {};
    if (url.username && url.password) {
      // Basic auth
      headers.Authorization = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    // Local models processing large tool schemas can take several minutes to
    // produce the first token, exceeding undici's default 5-minute headersTimeout.
    // Scope this to Ollama requests only via the custom fetch option.
    this._agent = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 60 * 60_000 });
    this._clientHost = url.toString();
    this._clientHeaders = headers;
    this._api = this.createClient();
  }

  /**
   * Build an Ollama client. The `ollama` package takes no per-request
   * AbortSignal (it only attaches an internal controller to streaming requests
   * and exposes a client-wide abort()), so cancellation has to be bound into
   * the fetch of a client made for that one request - hence the optional
   * `signal`. The undici Agent is shared across clients so connection pooling
   * and the raised timeouts survive.
   */
  private createClient(signal?: AbortSignal): Ollama {
    const fetchWithTimeout: typeof globalThis.fetch = (input, init) =>
      (globalThis.fetch as (i: typeof input, o: object) => Promise<Response>)(input, {
        ...init,
        dispatcher: this._agent,
        // Streaming requests already carry the client's own controller signal;
        // combine rather than replace so either source can cancel.
        ...(signal && { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
      });
    return new Ollama({ host: this._clientHost, headers: this._clientHeaders, fetch: fetchWithTimeout });
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    try {
      const models = await this._api.list();

      // In self-host, Ollama runs on the operator's own hardware, so describe
      // it as local; otherwise it is served remotely by the hosted platform.
      const isSelfHost = process.env.B4M_SELF_HOST === 'true';

      // Ollama /api/list doesn't include per-model capabilities or context
      // length, so fetch them via /api/show (one call per model, in parallel).
      // This is what tells us whether a model can use tools or accept images,
      // and its real context window. Without it every local model defaults to
      // "no tools" (disabling the tools picker even for tool-capable models
      // like Qwen) and a placeholder context size.
      return await Promise.all(
        models.models.map(async model => {
          const { capabilities, contextWindow: reportedContextWindow } = await this.getModelDetailsCached(model.name);
          // Advertise the window we will actually allocate, not the one the
          // model was trained for: callers size history against this number, so
          // publishing an uncapped 262K would have them build prompts Ollama
          // then truncates from the front.
          const contextWindow = OllamaBackend.effectiveContextWindow(reportedContextWindow);
          const modelInfo = {
            id: model.name,
            type: 'text',
            name: model.name,
            backend: ModelBackend.Ollama,
            contextWindow,
            max_tokens: OllamaBackend.advertisedOutputCap(contextWindow),
            supportsImageVariation: false,
            // Local models are free. pricing is a tier map keyed by a token
            // threshold (consumed by getTextModelCost), not a flat {input,output}
            // object; a flat shape resolves to an undefined tier and crashes cost
            // accounting in post-processing.
            pricing: {
              [contextWindow]: { input: 0, output: 0 },
            },
            // Deliberately costless: suppresses the [UNPRICED_MODEL] alarm.
            freeToRun: true,
            // Derived from the model's own reported capabilities rather than
            // hardcoded; falls back to false when /api/show is unavailable.
            supportsVision: capabilities.includes('vision'),
            supportsTools: capabilities.includes('tools'),
            can_think: capabilities.includes('thinking'),
            can_stream: true,
            logoFile: 'Ollama_Logo.svg',
            rank: 1,
            description: isSelfHost
              ? 'Runs locally on your own hardware via Ollama. No API key required, and nothing leaves your machine. Performance and capabilities vary by model.'
              : // Brand externalized for open-core; generic phrasing when APP_NAME is unset.
                `This model is served from ${
                  process.env.APP_NAME ? `${process.env.APP_NAME}'s` : 'the platform'
                } Ollama servers using publicly available open-source models. Performance and capabilities vary by model.`,
          } as ModelInfo;
          return modelInfo;
        })
      );
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.message.includes('503 Service Temporarily Unavailable')) {
        errorMessage = 'Ollama server is temporarily unavailable. Please try again later.';
      }
      // Connection errors here usually mean the Ollama server is down or the host is misconfigured.
      this._logger.warn('[OllamaBackend] Error fetching model info from Ollama:', errorMessage);
      return [];
    }
  }

  /** Ollama's default when a model doesn't report a context length. */
  private static readonly DEFAULT_CONTEXT_WINDOW = 8192;

  /**
   * Ceiling on the num_ctx we ask Ollama to allocate. Models advertise windows
   * far larger than a dev box can hold in KV cache (262K on qwen3.5), so the
   * useful value is the model's window capped at something affordable rather
   * than the advertised maximum. Override with OLLAMA_MAX_NUM_CTX.
   */
  private static readonly DEFAULT_MAX_NUM_CTX = 32768;

  /**
   * Output ceiling we advertise for a local model. Half of what we allocate, because advertising
   * the whole window made the server's context - output - buffer negative and emptied the prompt.
   *
   * Halving alone is not enough at the bottom of the range: OLLAMA_MAX_NUM_CTX accepts any positive
   * value, so an operator setting 2000 would leave exactly zero input budget for every local model
   * at once. The second bound keeps input room for any window ABOVE the safety buffer.
   *
   * At or below the buffer nothing here can: a 500-token window yields a cap of 1 and still leaves
   * 500 - 1 - 1000 negative. Clamping the window up to hide that would advertise more context than
   * the model has, which is the misreporting this whole change removes, so the honest answer is
   * that such a model cannot serve a chat prompt at all.
   */
  private static advertisedOutputCap(contextWindow: number): number {
    const halved = Math.floor(contextWindow / 2);
    return Math.max(1, Math.min(halved, contextWindow - CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS - 1));
  }

  /** A model's reported window clamped to what we are willing to allocate. */
  private static effectiveContextWindow(reported: number): number {
    const configuredCap = Number(process.env.OLLAMA_MAX_NUM_CTX);
    const cap = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : OllamaBackend.DEFAULT_MAX_NUM_CTX;
    return Math.min(reported, cap);
  }

  /** Per-model /api/show results, so the tool-call recursion shows once, not per round. */
  private readonly _modelDetails = new Map<string, Promise<{ capabilities: string[]; contextWindow: number }>>();

  private getModelDetailsCached(model: string): Promise<{ capabilities: string[]; contextWindow: number }> {
    let details = this._modelDetails.get(model);
    if (!details) {
      // getModelDetails never rejects (it falls back on error), so caching the
      // promise can't pin a rejection.
      details = this.getModelDetails(model);
      this._modelDetails.set(model, details);
    }
    return details;
  }

  /**
   * Fetch a model's capabilities and context window from Ollama (/api/show).
   * capabilities is e.g. ['completion', 'tools', 'vision']; the context length
   * lives in model_info under "<architecture>.context_length" (e.g.
   * "qwen2.context_length"). Returns safe defaults on any error so a transient
   * show() failure degrades gracefully instead of dropping the whole list.
   */
  private async getModelDetails(model: string): Promise<{ capabilities: string[]; contextWindow: number }> {
    try {
      const info = await this._api.show({ model });
      const capabilities = info.capabilities ?? [];

      // model_info is typed as a Map but arrives as a plain object over JSON;
      // handle both. The context length key is namespaced by architecture.
      const raw = info.model_info as unknown;
      const entries: [string, unknown][] =
        raw instanceof Map ? Array.from(raw.entries()) : Object.entries((raw ?? {}) as Record<string, unknown>);
      const ctx = entries.find(([k]) => k.endsWith('.context_length'))?.[1];
      const contextWindow = typeof ctx === 'number' && ctx > 0 ? ctx : OllamaBackend.DEFAULT_CONTEXT_WINDOW;

      return { capabilities, contextWindow };
    } catch (error) {
      this._logger.debug(`[OllamaBackend] Could not fetch details for ${model}:`, error);
      return { capabilities: [], contextWindow: OllamaBackend.DEFAULT_CONTEXT_WINDOW };
    }
  }

  /**
   * Ollama model parameters for a request. Everything here is silently dropped
   * if the `options` object is omitted, which is why num_ctx matters most:
   * without it the server falls back to its own 4096 default and truncates the
   * prompt from the front, taking the tool block with it - so a large turn
   * makes a tool-capable model answer that it has no tools. Sizing from the
   * model's own reported window keeps that consistent with the context length
   * the picker advertises.
   */
  private async buildModelOptions(
    model: string,
    options: Partial<ICompletionOptions>
  ): Promise<Partial<OllamaOptions>> {
    const { contextWindow } = await this.getModelDetailsCached(model);
    const numCtx = OllamaBackend.effectiveContextWindow(contextWindow);

    return {
      num_ctx: numCtx,
      ...(typeof options.temperature === 'number' && { temperature: options.temperature }),
      // A caller can still ask for more than the catalogue advertises - a stale
      // persisted setting, or a direct API request - so cap the output budget at
      // what we actually allocated.
      ...(typeof options.maxTokens === 'number' && { num_predict: Math.min(options.maxTokens, numCtx) }),
    };
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;

    const toolCallCount = options._internal?.toolCallCount ?? 0;
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    // Accumulators threaded across recursion. Consumers assign (not append) both
    // functionCalls and token usage on each callback, so the terminal turn must
    // emit the full running totals or earlier rounds are lost.
    const priorToolsUsed = options._internal?.accumToolsUsed ?? [];
    const priorInputTokens = options._internal?.accumInputTokens ?? 0;
    const priorOutputTokens = options._internal?.accumOutputTokens ?? 0;

    // Offer tools whenever the model has them and we're under the round cap.
    // executeTools:false still gets tools (the model must be able to emit calls);
    // we surface them without running, matching the other backends' CLI/agent path.
    const toolsAvailable = (options.tools?.length ?? 0) > 0;
    const offerTools = toolsAvailable && toolCallCount < maxToolCalls;
    if (toolsAvailable && !offerTools) {
      this._logger.warn(`[OllamaBackend] Max tool calls (${maxToolCalls}) reached; answering without tools.`);
    }

    const formattedTools = offerTools ? this.formatTools(options.tools ?? []) : [];
    const baseRequest = {
      model,
      // This backend withholds tools in place rather than recursing, so the strip has to track
      // `offerTools` here: prompts ordering the model to use a tool must not outlive the tools.
      messages: this.buildMessages(offerTools ? messages : stripToolDependentMessages(messages)),
      options: await this.buildModelOptions(model, options),
      ...(formattedTools.length > 0 && { tools: formattedTools }),
      // Drive Ollama's reasoning from the Thinking toggle. Gated upstream by
      // can_think, so think:true only reaches thinking-capable models (a
      // non-thinking model 400s on think:true; think:false is always accepted).
      ...(typeof options.thinking?.enabled === 'boolean' && { think: options.thinking.enabled }),
    };

    try {
      // Buffer this round's text on tool-eligible rounds: a tool-call round's
      // "content" is either empty or (for smaller models) the tool call itself as
      // JSON, neither of which should reach the user. Rounds with no tools offered
      // (no tools, or cap reached) stream live.
      const round = await this.runChatRound(baseRequest, options, callback, { buffer: offerTools });

      // Each round is a separate provider call billed independently, so sum both
      // (matches the OpenAI/Anthropic backends); prompt_eval_count is per-request.
      const inputTokens = priorInputTokens + (round.completionInfo.inputTokens ?? 0);
      const outputTokens = priorOutputTokens + (round.completionInfo.outputTokens ?? 0);

      // Prefer native tool_calls; fall back to a tool call the model emitted as
      // plain content (some smaller models do this instead of using tool_calls).
      let toolCalls = this.normalizeToolCalls(round.toolCalls);
      if (toolCalls.length === 0 && offerTools) {
        toolCalls = this.parseContentToolCall(round.content, options.tools ?? []);
      }
      const toolsUsed = [
        ...priorToolsUsed,
        ...toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments, id: tc.id })),
      ];

      // No tool call this round -> final answer. Emit the buffered content (empty
      // if it was streamed live) plus the accumulated tool list and token totals.
      if (toolCalls.length === 0) {
        await callback([offerTools ? round.content : ''], {
          inputTokens,
          outputTokens,
          ...(toolsUsed.length > 0 && { toolsUsed }),
          ...(round.completionInfo.stopReason ? { stopReason: round.completionInfo.stopReason } : {}),
        });
        return;
      }

      // executeTools:false -> surface the tool calls to the caller (e.g. the CLI /
      // ReAct agent) without running them, then stop. Never emit the raw call JSON.
      if (options.executeTools === false) {
        await callback([''], { inputTokens, outputTokens, toolsUsed });
        return;
      }

      // Partition into calls we can run and calls naming a tool that isn't
      // registered here (small models hallucinate tool names). For the unknown
      // ones we still push a not-available result so the next round has changed
      // history and the model can self-correct - otherwise a phantom native call
      // would recurse on identical history and burn the whole round budget.
      const resolved = toolCalls
        .map(tc => ({ tc, toolFn: options.tools?.find(t => t.toolSchema.name === tc.name)?.toolFn }))
        .filter((r): r is { tc: NormalizedToolCall; toolFn: ICompletionOptionTools['toolFn'] } => !!r.toolFn);
      const unknownCalls = toolCalls.filter(tc => !options.tools?.some(t => t.toolSchema.name === tc.name));

      for (const tc of unknownCalls) {
        this.pushToolMessages(
          messages,
          { id: tc.id, name: tc.name, parameters: tc.arguments || '{}' },
          `Error: tool "${tc.name}" is not available. Do not call it again; answer directly or use a listed tool.`
        );
      }

      const outcomes = await executeToolsBatch<string>(
        resolved.map(({ tc, toolFn }) => async () => {
          let params: Record<string, unknown> = {};
          try {
            params = JSON.parse(tc.arguments || '{}');
          } catch {
            /* leave params empty; the tool will surface its own validation error */
          }
          this._logger.debug(`[OllamaBackend] Executing tool ${tc.name}`);
          return String(await toolFn(params));
        }),
        { parallel: options.parallelToolExecution !== false, maxConcurrency: options.maxParallelTools }
      );

      outcomes.forEach((outcome, i) => {
        const { tc } = resolved[i];
        const params = tc.arguments || '{}';
        if (outcome.ok) {
          this.pushToolMessages(messages, { id: tc.id, name: tc.name, parameters: params }, outcome.result);
        } else {
          // A denied permission must abort, not be fed back as a result.
          if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
          const errorMsg = `Error running ${tc.name}: ${
            outcome.error instanceof Error ? outcome.error.message : 'Unknown error'
          }`;
          this.pushToolMessages(messages, { id: tc.id, name: tc.name, parameters: params }, errorMsg);
        }
      });

      // Only calls we actually ran count as used; hallucinated tool names must
      // not inflate the reported tool list.
      const executedToolsUsed = [
        ...priorToolsUsed,
        ...resolved.map(({ tc }) => ({ name: tc.name, arguments: tc.arguments, id: tc.id })),
      ];

      // Stop before another round if the request was cancelled mid-flight, rather
      // than issuing up to maxToolCalls more model calls and tool executions.
      if (options.abortSignal?.aborted) {
        await callback([''], { inputTokens, outputTokens, toolsUsed: executedToolsUsed });
        return;
      }

      // Recurse so the model turns the tool results into a final answer, carrying
      // the accumulated tool list and token totals forward.
      await this.complete(
        model,
        messages,
        {
          ...options,
          _internal: {
            ...options._internal,
            toolCallCount: toolCallCount + 1,
            accumToolsUsed: executedToolsUsed,
            accumInputTokens: inputTokens,
            accumOutputTokens: outputTokens,
          },
        },
        callback
      );
    } catch (error) {
      // Now that the abort signal reaches the transport, pressing Stop surfaces
      // here as an AbortError. That is the request working as intended, not a
      // fault, so don't log it at error level; the caller still needs the throw.
      if (error instanceof Error && isUserInitiatedAbort(error, options.abortSignal)) {
        this._logger.debug('[OllamaBackend] Ollama request cancelled by the caller');
      } else {
        this._logger.error('[OllamaBackend] Error during Ollama API call:', error);
      }
      throw error;
    }
  }

  /**
   * Run a single Ollama chat turn. Streams text chunks to `callback` unless
   * `buffer` is set (used for tool-eligible rounds, where the content is
   * withheld until we know whether it is a tool call or the final answer).
   * Returns the full text, any native tool calls, and token usage.
   */
  private async runChatRound(
    baseRequest: {
      model: string;
      messages: OllamaMessage[];
      options?: Partial<OllamaOptions>;
      tools?: Tool[];
      think?: boolean;
    },
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>,
    { buffer }: { buffer: boolean }
  ): Promise<{ content: string; toolCalls: ToolCall[]; completionInfo: CompletionInfo }> {
    const toolCalls: ToolCall[] = [];
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason: string | undefined;

    // A cancellable request needs the signal bound into the transport: the
    // between-rounds abort check below can't interrupt a call already in
    // flight, and a non-streaming round is one long blocking request.
    const api = options.abortSignal ? this.createClient(options.abortSignal) : this._api;

    if (options.stream) {
      const response = await api.chat({ ...baseRequest, stream: true as const });
      let startedThinking = false;
      let stoppedThinking = false;
      // Modern Ollama streams reasoning in a separate `thinking` field rather
      // than inline <think> tags; track whether we've opened a wrapper for it.
      let thinkingFieldOpen = false;

      for await (const chunk of response) {
        if (chunk.message.tool_calls?.length) {
          toolCalls.push(...chunk.message.tool_calls);
        }

        let piece = '';
        // Wrap the separate thinking field in <think>..</think> so the consumer
        // (which parses those tags) renders it as reasoning, then the answer.
        const thinkPiece = chunk.message.thinking || '';
        if (thinkPiece) {
          if (!thinkingFieldOpen) {
            piece += '<think>';
            thinkingFieldOpen = true;
          }
          piece += thinkPiece;
        }
        const contentPiece = chunk.message.content || '';
        if (contentPiece) {
          if (thinkingFieldOpen) {
            piece += '</think>';
            thinkingFieldOpen = false;
          }
          // Legacy: older models emit <think> inline in content instead.
          startedThinking = startedThinking || contentPiece.includes('<think>');
          stoppedThinking = stoppedThinking || contentPiece.includes('</think>');
          piece += contentPiece;
        }

        // Close an unterminated reasoning block at end of stream, whether it came
        // from the thinking field or an inline <think> the model never closed.
        // Non-reasoning models (e.g. qwen2.5-coder) emit neither, so nothing is
        // appended for them.
        if (chunk.done && (thinkingFieldOpen || (startedThinking && !stoppedThinking))) {
          piece = `${piece}</think>`;
          thinkingFieldOpen = false;
        }

        content += piece;
        inputTokens = Math.max(inputTokens, chunk.prompt_eval_count || 0);
        outputTokens += chunk.eval_count || 0;
        if (chunk.done_reason) {
          doneReason = chunk.done_reason;
        }

        if (!buffer && piece) {
          await callback([piece], { inputTokens, outputTokens });
        }
      }
    } else {
      const response = await api.chat({ ...baseRequest, stream: false as const });
      if (response.message.tool_calls?.length) {
        toolCalls.push(...response.message.tool_calls);
      }
      // Prepend reasoning (from the separate thinking field) as a <think> block
      // so it renders consistently with the streaming path.
      const think = response.message.thinking || '';
      content = (think ? `<think>${think}</think>` : '') + (response.message.content || '');
      inputTokens = response.prompt_eval_count || 0;
      outputTokens = response.eval_count || 0;
      doneReason = response.done_reason;
      if (!buffer) {
        await callback([content], { inputTokens, outputTokens });
      }
    }

    const stopReason = normalizeOllamaDoneReason(doneReason);
    return { content, toolCalls, completionInfo: { inputTokens, outputTokens, ...(stopReason ? { stopReason } : {}) } };
  }

  /** Normalize Ollama's native tool_calls into the shared NormalizedToolCall shape. */
  private normalizeToolCalls(toolCalls: ToolCall[]): NormalizedToolCall[] {
    return toolCalls.map((tc, i) => ({
      name: tc.function.name,
      arguments: JSON.stringify(tc.function.arguments ?? {}),
      id: `ollama-tool-${i}-${tc.function.name}`,
    }));
  }

  /**
   * Some smaller models emit tool calls as plain message content instead of
   * using the native tool_calls field: a bare {"name":...,"arguments":{...}},
   * the same wrapped in a ```json fence, or several such objects run together
   * ({...} {...}). Recover every such object that names an available tool; if
   * none match, the content is a normal answer.
   *
   * Guards against false positives: reasoning traces (<think>...</think>) are
   * stripped first. The search source is a leading bare object (only when the
   * reply STARTS with one) plus every fenced body - so a call wrapped in a fence
   * after preamble prose is recovered, a bare call is not lost just because the
   * reply also contains an unrelated fence, and JSON merely quoted mid-prose
   * ("the math_evaluate tool takes {...}") is ignored. The seen-set dedupes any
   * overlap between the two sources.
   *
   * Because any fenced block is a search source, a fenced EXAMPLE of a real
   * (authorized) tool is also recovered and executed. This stays bounded to
   * authorized tools (tryParseToolCallJson requires a name present in `tools`),
   * so there is no privilege escalation - only a wider trigger surface.
   */
  private parseContentToolCall(content: string, tools: ICompletionOptionTools[]): NormalizedToolCall[] {
    const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fenced = this.extractFencedBlocks(withoutThink);
    const source = [withoutThink.startsWith('{') ? withoutThink : '', ...fenced].join('\n');
    if (!source.trim()) return [];

    const calls: NormalizedToolCall[] = [];
    const seen = new Set<string>();
    for (const candidate of this.extractJsonObjects(source)) {
      const call = this.tryParseToolCallJson(candidate, tools);
      if (!call) continue;
      const key = `${call.name}:${call.arguments}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ ...call, id: `ollama-content-tool-${calls.length}-${call.name}` });
    }
    return calls;
  }

  /**
   * Return the body of every ```-fenced block, so a tool call the model wrapped
   * in a fence after preamble prose can be isolated from the surrounding text.
   */
  private extractFencedBlocks(content: string): string[] {
    const blocks: string[] = [];
    const fenceRegex = /```[^\n]*\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(content)) !== null) {
      blocks.push(match[1]);
    }
    return blocks;
  }

  /**
   * Extract every balanced top-level {...} substring from arbitrary text. String
   * contents are respected so braces inside JSON strings don't throw off nesting,
   * and code fences / prose around the objects are ignored. Handles multiple
   * objects run together, which is how some models emit parallel tool calls.
   */
  private extractJsonObjects(content: string): string[] {
    const objects: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(content.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return objects;
  }

  /**
   * Parse one candidate string as a tool call naming a known tool. Models
   * improvise the shape, so accept the common ones:
   *   {"name":"t","arguments":{...}}          (Ollama/most)
   *   {"function":"t","arguments":{...}}       (function-as-name)
   *   {"function":{"name":"t","arguments":{}}} (OpenAI-style nested)
   * plus "parameters"/"args" aliases for the arguments.
   */
  private tryParseToolCallJson(text: string, tools: ICompletionOptionTools[]): Omit<NormalizedToolCall, 'id'> | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    let name: unknown;
    let args: unknown;
    const fn = obj.function;
    if (fn && typeof fn === 'object') {
      // OpenAI-style nested { function: { name, arguments } }
      name = (fn as Record<string, unknown>).name;
      args = (fn as Record<string, unknown>).arguments;
    } else {
      // Flat: the name may sit under any of these keys depending on the model.
      name = obj.name ?? obj.function ?? obj.tool ?? obj.tool_name;
    }
    if (args === undefined) {
      args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
    }

    if (typeof name !== 'string' || !tools.some(t => t.toolSchema.name === name)) return null;
    return {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    };
  }

  pushToolMessages(
    messages: IMessage[],
    tool: { name: string; id: string; parameters: string },
    result: string,
    _thinkingBlocks?: unknown[]
  ) {
    // Parse the parameters string back to an object - Ollama's native format
    // requires arguments as an object, not a JSON string.
    let argumentsObj: Record<string, unknown>;
    try {
      argumentsObj = JSON.parse(tool.parameters);
    } catch {
      argumentsObj = { _raw: tool.parameters };
    }

    messages.push({
      content: '',
      role: 'assistant',
      tool_calls: [
        {
          function: {
            name: tool.name,
            arguments: argumentsObj,
          },
        },
      ],
    } as unknown as IMessage);

    // Ollama uses role: 'tool' with tool_name for results - no tool_call_id needed (unlike OpenAI)
    messages.push({
      role: 'tool',
      tool_name: tool.name,
      content: result,
    } as unknown as IMessage);
  }

  /**
   * Convert ICompletionOptionTools into Ollama's Tool schema format.
   */
  private formatTools(tools: ICompletionOptionTools[]): Tool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        ...tool.toolSchema,
        parameters: {
          ...tool.toolSchema.parameters,
          required: tool.toolSchema.parameters.required ?? [],
        },
      },
    }));
  }

  /**
   * Map IMessage[] to Ollama's Message[], preserving tool_calls for multi-turn
   * tool conversations (added by pushToolMessages).
   * First converts B4M standard format (tool_use/tool_result) to OpenAI-compatible
   * format since Ollama uses the same tool_calls/role:tool convention.
   */
  private buildMessages(messages: IMessage[]): OllamaMessage[] {
    const converted = convertMessagesToOpenAIFormat(messages);
    return converted.map(msg => {
      const raw = msg as unknown as Record<string, unknown>;
      const mapped: OllamaMessage = { role: msg.role, content: '' };

      if (Array.isArray(msg.content)) {
        // Ollama has no multimodal content-block array: text goes in `content`
        // and images in `images` as RAW base64 (no data: prefix). Only text/image
        // blocks reach here - convertMessagesToOpenAIFormat already flattened any
        // tool_use/tool_result blocks into tool_calls/tool_name above.
        const texts: string[] = [];
        const images: string[] = [];
        for (const block of msg.content as MessageContentObject[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          } else if (block.type === 'image') {
            if (block.source.type === 'base64') {
              images.push(block.source.data);
            } else {
              // Symmetric with the image_url drop below: Ollama needs inline base64.
              this._logger.debug('[OllamaBackend] Dropping non-base64 image block; Ollama requires inline base64.');
            }
          } else if (block.type === 'image_url') {
            const dataUrl = block.image_url.url.match(/^data:[^,]*;base64,(.+)$/s);
            if (dataUrl) {
              images.push(dataUrl[1]);
            } else {
              // Ollama can't fetch a remote URL; it needs inline base64.
              this._logger.debug('[OllamaBackend] Dropping non-data image_url; Ollama requires inline base64.');
            }
          }
        }
        mapped.content = texts.join('\n');
        if (images.length > 0) mapped.images = images;
      } else {
        mapped.content = msg.content != null ? String(msg.content) : '';
      }

      // Carry through tool_calls and tool_name so the conversation history is intact
      if (Array.isArray(raw.tool_calls)) {
        mapped.tool_calls = raw.tool_calls as ToolCall[];
      }
      if (typeof raw.tool_name === 'string') {
        mapped.tool_name = raw.tool_name;
      }
      return mapped;
    });
  }

  async listModels(): Promise<ModelResponse[]> {
    try {
      this._logger.debug('[OllamaBackend] Listing models from Ollama');
      const response = await this._api.list();
      this._logger.debug('[OllamaBackend] Models listed from Ollama:', response.models);
      return response.models;
    } catch (error: any) {
      this._logger.error('[OllamaBackend] Error listing models from Ollama:', error);
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('Failed to fetch')) {
        throw new Error(`Could not connect to Ollama. Please make sure it is running at ${this._host}`);
      }
      throw error;
    }
  }
}
