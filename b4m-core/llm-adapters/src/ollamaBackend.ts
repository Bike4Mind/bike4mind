import { IMessage, ModelBackend, PermissionDeniedError, type ModelInfo } from '@bike4mind/common';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  ICompletionBackend,
  ICompletionOptions,
  ICompletionOptionTools,
} from './backend';
import { Ollama, Message as OllamaMessage, ModelResponse, Tool, ToolCall } from 'ollama';
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
    const agent = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 60 * 60_000 });
    const fetchWithTimeout: typeof globalThis.fetch = (input, init) =>
      (globalThis.fetch as (i: typeof input, o: object) => Promise<Response>)(input, {
        ...init,
        dispatcher: agent,
      });
    this._api = new Ollama({ host: url.toString(), headers, fetch: fetchWithTimeout });
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
          const { capabilities, contextWindow } = await this.getModelDetails(model.name);
          const modelInfo = {
            id: model.name,
            type: 'text',
            name: model.name,
            backend: ModelBackend.Ollama,
            contextWindow,
            max_tokens: contextWindow,
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
      messages: this.buildMessages(messages),
      ...(formattedTools.length > 0 && { tools: formattedTools }),
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
      this._logger.error('[OllamaBackend] Error during Ollama API call:', error);
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
    baseRequest: { model: string; messages: OllamaMessage[]; tools?: Tool[] },
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>,
    { buffer }: { buffer: boolean }
  ): Promise<{ content: string; toolCalls: ToolCall[]; completionInfo: CompletionInfo }> {
    const toolCalls: ToolCall[] = [];
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason: string | undefined;

    if (options.stream) {
      const response = await this._api.chat({ ...baseRequest, stream: true as const });
      let startedThinking = false;
      let stoppedThinking = false;

      for await (const chunk of response) {
        if (chunk.message.tool_calls?.length) {
          toolCalls.push(...chunk.message.tool_calls);
        }

        let piece = chunk.message.content || '';
        startedThinking = startedThinking || piece.includes('<think>');
        stoppedThinking = stoppedThinking || piece.includes('</think>');
        // Close a thinking block only if the model actually opened one but never
        // closed it. Non-reasoning models (e.g. qwen2.5-coder) emit no <think>
        // at all, so appending </think> unconditionally left a stray closing tag.
        if (chunk.done && startedThinking && !stoppedThinking) {
          piece = `${piece}</think>`;
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
      const response = await this._api.chat({ ...baseRequest, stream: false as const });
      if (response.message.tool_calls?.length) {
        toolCalls.push(...response.message.tool_calls);
      }
      content = response.message.content || '';
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
   * stripped first, and we only treat content as a call when the model emits it
   * as its response (starts with a JSON object or a code fence). JSON merely
   * quoted inside prose ("the math_evaluate tool takes {...}") is left alone.
   */
  private parseContentToolCall(content: string, tools: ICompletionOptionTools[]): NormalizedToolCall[] {
    const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!withoutThink.startsWith('{') && !withoutThink.startsWith('```')) return [];

    const calls: NormalizedToolCall[] = [];
    const seen = new Set<string>();
    for (const candidate of this.extractJsonObjects(withoutThink)) {
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
      const mapped: OllamaMessage = {
        role: msg.role,
        content: msg.content != null ? String(msg.content) : '',
      };
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
