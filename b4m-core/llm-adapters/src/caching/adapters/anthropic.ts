import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * Anthropic-specific caching adapter
 * Adds explicit cache_control markers to content blocks
 */
export class AnthropicCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy): Record<string, unknown> {
    if (!strategy.enableCaching) return apiParams;

    const ttl = strategy.cacheTTL ?? '5m';
    const modifiedParams = { ...apiParams };

    // Cache tools (mark last tool)
    const tools = modifiedParams.tools as unknown[] | undefined;
    if (strategy.cacheTools && Array.isArray(tools) && tools.length > 0) {
      const toolsCopy = [...tools];
      const lastTool = toolsCopy[toolsCopy.length - 1] as Record<string, unknown>;
      toolsCopy[toolsCopy.length - 1] = {
        ...lastTool,
        cache_control: { type: 'ephemeral', ...(ttl === '1h' ? { ttl } : {}) },
      };
      modifiedParams.tools = toolsCopy;
    }

    // Cache system messages (mark last block)
    const systemParam = modifiedParams.system;
    if (strategy.cacheSystemPrompt && systemParam) {
      const systemArray = Array.isArray(systemParam)
        ? ([...systemParam] as Record<string, unknown>[])
        : [{ type: 'text', text: systemParam }];

      if (systemArray.length > 0) {
        const lastBlock = systemArray[systemArray.length - 1];
        systemArray[systemArray.length - 1] = {
          ...lastBlock,
          cache_control: { type: 'ephemeral', ...(ttl === '1h' ? { ttl } : {}) },
        };
        modifiedParams.system = systemArray;
      }
    }

    // Cache conversation history (mark last message)
    const messagesParam = modifiedParams.messages as unknown[] | undefined;
    if (strategy.cacheConversationHistory && Array.isArray(messagesParam) && messagesParam.length > 0) {
      const messages = [...messagesParam] as Record<string, unknown>[];
      const lastMsg = messages[messages.length - 1];
      const msgContent = lastMsg.content;

      // Convert content to array if needed
      let contentArray: Record<string, unknown>[];
      if (typeof msgContent === 'string') {
        contentArray = [{ type: 'text', text: msgContent }];
      } else if (Array.isArray(msgContent)) {
        contentArray = [...msgContent] as Record<string, unknown>[];
      } else {
        return modifiedParams; // Skip if content is not string or array
      }

      // Mark last content block
      if (contentArray.length > 0) {
        const lastBlock = contentArray[contentArray.length - 1];
        contentArray[contentArray.length - 1] = {
          ...lastBlock,
          cache_control: { type: 'ephemeral', ...(ttl === '1h' ? { ttl } : {}) },
        };

        messages[messages.length - 1] = {
          ...lastMsg,
          content: contentArray,
        };
        modifiedParams.messages = messages;
      }
    }

    return modifiedParams;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
    const cacheWriteTokens = (usage.cache_creation_input_tokens as number) || 0;
    const uncachedTokens = (usage.input_tokens as number) || 0;
    const totalInputTokens = cacheReadTokens + cacheWriteTokens + uncachedTokens;

    const cacheHitRate = totalInputTokens > 0 ? (cacheReadTokens / totalInputTokens) * 100 : 0;

    // 90% savings on cached tokens
    const costSavingsPercent = cacheHitRate * 0.9;

    // Estimate latency reduction (cached tokens processed ~10x faster)
    const estimatedLatencyReduction = cacheHitRate * 0.85;

    return {
      provider: ModelBackend.Anthropic,
      model,
      totalInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      uncachedTokens,
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        // TTL is set at request time, not extractable from the response;
        // we only know whether a cache write occurred (cacheWriteTokens > 0).
        hadCacheWrite: cacheWriteTokens > 0,
      },
    };
  }
}
