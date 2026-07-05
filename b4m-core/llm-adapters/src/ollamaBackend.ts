import { IMessage, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { CompletionInfo, ICompletionBackend, ICompletionOptions, ICompletionOptionTools } from './backend';
import { Ollama, Message as OllamaMessage, ModelResponse, Tool, ToolCall } from 'ollama';
import { ILogger, Logger } from '@bike4mind/observability';
import { Agent } from 'undici';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';

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
      // TODO: This is a placeholder value. We need to get the actual context window from the model
      const contextWindow = 8192;

      return models.models.map(model => {
        const modelInfo = {
          id: model.name,
          type: 'text',
          name: model.name,
          backend: ModelBackend.Ollama,
          contextWindow,
          // TODO: This is a placeholder value. We need to get the actual max tokens from the model
          max_tokens: contextWindow,
          supportsImageVariation: false,
          // Local models are free. pricing is a tier map keyed by a token
          // threshold (consumed by getTextModelCost), not a flat {input,output}
          // object; a flat shape resolves to an undefined tier and crashes cost
          // accounting in post-processing.
          pricing: {
            [contextWindow]: { input: 0, output: 0 },
          },
          supportsVision: false,
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
      });
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

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;

    const formattedTools = this.formatTools(options.tools ?? []);
    const baseRequest = {
      model,
      messages: this.buildMessages(messages),
      ...(formattedTools.length > 0 && { tools: formattedTools }),
    };

    try {
      if (options.stream) {
        const response = await this._api.chat({
          ...baseRequest,
          stream: true as const,
        });

        let inputTokens = 0;
        let outputTokens = 0;
        let startedThinking = false;
        let stoppedThinking = false;
        const accumulatedToolCalls: ToolCall[] = [];

        for await (const chunk of response) {
          // Accumulate tool_calls - they typically arrive in the final chunk
          if (chunk.message.tool_calls?.length) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }

          let content = chunk.message.content || '';
          startedThinking = startedThinking || content.includes('<think>');
          stoppedThinking = stoppedThinking || content.includes('</think>');

          // Close a thinking block only if the model actually opened one but
          // never closed it. Non-reasoning models (e.g. qwen2.5-coder) emit no
          // <think> at all, so appending </think> unconditionally left a stray
          // closing tag on every reply.
          if (chunk.done && startedThinking && !stoppedThinking) {
            content = `${content}</think>`;
          }

          inputTokens = Math.max(inputTokens, chunk.prompt_eval_count || 0);
          outputTokens += chunk.eval_count || 0;

          const completionInfo: CompletionInfo = { inputTokens, outputTokens };

          // Signal tool calls to the ReActAgent on the final chunk
          if (chunk.done && accumulatedToolCalls.length > 0) {
            completionInfo.toolsUsed = accumulatedToolCalls.map((tc, i) => ({
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments),
              id: `ollama-tool-${i}-${tc.function.name}`,
            }));
          }

          await callback([content], completionInfo);
        }
      } else {
        const response = await this._api.chat({
          ...baseRequest,
          stream: false as const,
        });

        const toolCalls = response.message.tool_calls ?? [];
        const completionInfo: CompletionInfo = {
          inputTokens: response.prompt_eval_count || 0,
          outputTokens: response.eval_count || 0,
        };

        if (toolCalls.length > 0) {
          completionInfo.toolsUsed = toolCalls.map((tc, i) => ({
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
            id: `ollama-tool-${i}-${tc.function.name}`,
          }));
        }

        await callback([response.message.content || ''], completionInfo);
      }
    } catch (error) {
      this._logger.error('[OllamaBackend] Error during Ollama API call:', error);
      throw error;
    }
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
