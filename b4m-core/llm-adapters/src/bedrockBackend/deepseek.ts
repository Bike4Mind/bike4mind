import { ChatModels, IMessage, type ModelInfo, ModelBackend } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';

export default class DeepSeekBedrockBackend extends BaseBedrockBackend {
  private isSpecialTask: boolean = false;
  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.DEEPSEEK_R1_BEDROCK,
        type: 'text',
        name: 'DeepSeek R1',
        backend: ModelBackend.Bedrock,
        contextWindow: 128_000,
        supportsImageVariation: false,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
          32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
        },
        supportsVision: false,
        logoFile: 'deepseek-logo.png',
        rank: 10,
        description:
          "DeepSeek's R1 model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
      },
      {
        id: ChatModels.DEEPSEEK_V3_1,
        type: 'text',
        name: 'DeepSeek v3.1',
        backend: ModelBackend.Bedrock,
        contextWindow: 128_000,
        supportsImageVariation: false,
        max_tokens: 32_768,
        can_stream: true,
        pricing: {
          // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
          32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
        },
        supportsVision: false,
        logoFile: 'deepseek-logo.png',
        rank: 10,
        description:
          "DeepSeek's latest model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
      },
    ];
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    // Check if this is v3.1 model (uses messages format) vs R1 (uses prompt format)
    const isV3Model = model === ChatModels.DEEPSEEK_V3_1;

    if (isV3Model) {
      // DeepSeek v3.1 uses messages format similar to Anthropic/OpenAI
      // Include all message roles (user, assistant, system) in the messages array
      const formattedMessages = messages
        .filter(m => m.content !== null && m.content !== undefined)
        .map(m => {
          // Ensure content is properly formatted
          if (typeof m.content === 'string' || Array.isArray(m.content)) {
            return {
              role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
              content: m.content,
            };
          }
          return {
            role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
            content: JSON.stringify(m.content),
          };
        })
        .filter(m => {
          // Remove messages with empty content
          if (typeof m.content === 'string') {
            return m.content !== '';
          }
          return true;
        });

      const body: Record<string, unknown> = {
        messages: formattedMessages,
        max_tokens: options.maxTokens ?? 512,
      };

      // Add optional parameters
      if (typeof options.temperature === 'number') {
        body.temperature = options.temperature;
      }

      if (typeof options.topP === 'number') {
        body.top_p = options.topP;
      }

      // Add stop sequences if provided
      if (options.stop && Array.isArray(options.stop) && options.stop.length > 0) {
        body.stop = options.stop;
      }

      return {
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      };
    }

    // Original R1 format using prompt field
    // Check if this is a summarization task
    const isSummarizationTask = messages.some(
      m =>
        typeof m.content === 'string' &&
        m.content.toLowerCase().includes('generate an abstract summary of this session')
    );

    const isTitleGenerationTask = messages.some(
      m => typeof m.content === 'string' && m.content.toLowerCase().includes('give a title to this session')
    );

    let prompt: string;

    this.isSpecialTask = isSummarizationTask || isTitleGenerationTask;

    if (isSummarizationTask || isTitleGenerationTask) {
      // For special tasks, use special format
      const systemMessage = messages.find(
        m =>
          typeof m.content === 'string' &&
          (m.content.toLowerCase().includes('generate an abstract summary of this session') ||
            m.content.toLowerCase().includes('give a title to this session'))
      );
      const userMessage = messages.find(m => m.role === 'user');

      const systemContent = typeof systemMessage?.content === 'string' ? systemMessage.content : '';
      const userContent = typeof userMessage?.content === 'string' ? userMessage.content : '';

      const finalResponse = isSummarizationTask ? 'Summary:' : 'Title:';

      prompt = `Task: 
                \n${systemContent}

                -- START OF CONTENT for TASK --
                \n\n${userContent}
                -- END OF CONTENT --

                \n\n${finalResponse}`;
    } else {
      // Use standard conversation format for regular chats
      prompt = messages
        .map(m => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `${role}: ${content}`;
        })
        .join('\n\n');

      // Add Assistant prompt if last message was from user
      prompt += messages[messages.length - 1]?.role === 'user' ? '\n\nAssistant:' : '';
    }

    // Use simpler stop sequences
    const stopSequences = ['\nHuman:', '\n\nHuman:', 'Human:', '\nHuman'];

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt,
        temperature: options.temperature ?? 0.5,
        top_p: options.topP ?? 0.9,
        max_tokens: options.maxTokens ?? 512,
        stop: stopSequences,
      }),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    // Check if this is v3.1 model (different response format)
    const isV3Model = model === ChatModels.DEEPSEEK_V3_1;

    if (isV3Model) {
      // DeepSeek v3.1 returns { choices: [{ message: { content: string, role: string }, finish_reason: string }] }
      const response = chunk as {
        choices: Array<{
          message?: { content?: string; role?: string };
          finish_reason?: string;
          delta?: { content?: string };
        }>;
      };

      return {
        done: true,
        chunk: {
          model,
          choices: (response.choices || []).map((choice, index) => {
            // Extract content from message or delta
            const content = choice.message?.content || choice.delta?.content || '';
            return {
              status: ChoiceStatus.END,
              statusEndReason:
                choice.finish_reason === 'stop' || choice.finish_reason === 'length'
                  ? ChoiceEndReason.STOP
                  : ChoiceEndReason.COMPLETE,
              index,
              chunkText: this.processThinkingTags(content),
            };
          }),
        },
      };
    }

    // Original R1 format: { choices: [{ text, stop_reason }] }
    const response = chunk as {
      choices: Array<{ text?: string; stop_reason?: string }>;
    };
    return {
      done: true,
      chunk: {
        model,
        choices: (response.choices || []).map((choice, index) => ({
          status: ChoiceStatus.END,
          statusEndReason: choice.stop_reason === 'stop' ? ChoiceEndReason.STOP : ChoiceEndReason.COMPLETE,
          index,
          chunkText: this.processThinkingTags(choice.text || ''),
        })),
      },
    };
  }

  private processThinkingTags(text: string | undefined | null): string {
    // Handle null/undefined text
    if (!text) {
      return '';
    }

    // Deepseek does not have opening <think> tag and only returns closing </think> tags, so we need to add the open tag if it's missing.
    // Not necessary for special tasks.

    // Remove thinking tags for summarization and title generation tasks
    if (this.isSpecialTask) {
      // if text has both <think></think> tags
      if (text.includes('<think>') && text.includes('</think>')) {
        return text.replace(/<think>.*<\/redacted_reasoning>/gs, '');
      }

      // if text has only </think> tags, remove everything before the last </think> tag
      if (text.includes('</think>')) {
        const lastThinkIndex = text.lastIndexOf('</think>');
        return text.substring(lastThinkIndex + '</think>'.length);
      }

      return text;
    }

    // Simple fix for missing open tag: if text has </think> without <think>, add <think> at start
    if (text.includes('</think>') && !text.includes('<think>')) {
      return '<think>\n' + text;
    }

    return text;
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    // Streaming not supported for DeepSeek on Bedrock as of docs
    return this.translateChunk(model, chunk);
  }

  pushToolMessages(
    messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    return messages;
  }
}
