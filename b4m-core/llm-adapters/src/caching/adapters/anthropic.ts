import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * Anthropic's hard ceiling on `cache_control` markers per request. Exceeding it fails the
 * WHOLE request with `ValidationException: A maximum of 4 blocks with cache_control may be
 * provided`, which is non-retryable - so an over-budget request loses the turn outright,
 * after the user has already waited for it.
 */
const MAX_CACHE_CONTROL_BLOCKS = 4;

/** Does this block already carry a marker? Re-marking one costs no budget. */
function hasMarker(block: unknown): boolean {
  return !!block && typeof block === 'object' && 'cache_control' in (block as Record<string, unknown>);
}

/**
 * Markers already on the request. Callers upstream attach their own before this runs -
 * `bedrockBackend/anthropic.ts` marks every system block flagged `cache: true` to declare a
 * mid-stack breakpoint - so this adapter's budget is whatever they left, not the full four.
 */
function countMarkers(params: Record<string, unknown>): number {
  let count = 0;
  const tools = params.tools;
  if (Array.isArray(tools)) count += tools.filter(hasMarker).length;
  const system = params.system;
  if (Array.isArray(system)) count += system.filter(hasMarker).length;
  const messages = params.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = (message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content)) count += content.filter(hasMarker).length;
    }
  }
  return count;
}

/**
 * Anthropic-specific caching adapter
 * Adds explicit cache_control markers to content blocks
 */
export class AnthropicCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy, logger?: Logger): Record<string, unknown> {
    if (!strategy.enableCaching) return apiParams;

    const ttl = strategy.cacheTTL ?? '5m';
    const modifiedParams = { ...apiParams };
    const cacheControl = { type: 'ephemeral', ...(ttl === '1h' ? { ttl } : {}) };

    // Budget = the ceiling minus what upstream already attached. Breakpoints are added in
    // descending durability below, so when the budget runs out the LEAST valuable one is the
    // one dropped: the history anchor moves every turn and yields the shortest-lived prefix,
    // while the system prefix and the tool schemas are stable across a whole conversation.
    let budget = MAX_CACHE_CONTROL_BLOCKS - countMarkers(modifiedParams);
    const dropped: string[] = [];

    /** Claim one marker slot, or record the miss. Re-marking a marked block is free. */
    const claim = (name: string, alreadyMarked: boolean): boolean => {
      if (alreadyMarked) return true;
      if (budget <= 0) {
        dropped.push(name);
        return false;
      }
      budget -= 1;
      return true;
    };

    // Cache system messages (mark last block) - closes the large, stable shared prefix.
    const systemParam = modifiedParams.system;
    if (strategy.cacheSystemPrompt && systemParam) {
      const systemArray = Array.isArray(systemParam)
        ? ([...systemParam] as Record<string, unknown>[])
        : [{ type: 'text', text: systemParam }];

      if (systemArray.length > 0) {
        const lastBlock = systemArray[systemArray.length - 1];
        if (claim('system', hasMarker(lastBlock))) {
          systemArray[systemArray.length - 1] = { ...lastBlock, cache_control: cacheControl };
          modifiedParams.system = systemArray;
        }
      }
    }

    // Cache tools (mark last tool) - stable for as long as the tool set is.
    const tools = modifiedParams.tools as unknown[] | undefined;
    if (strategy.cacheTools && Array.isArray(tools) && tools.length > 0) {
      const toolsCopy = [...tools];
      const lastTool = toolsCopy[toolsCopy.length - 1] as Record<string, unknown>;
      if (claim('tools', hasMarker(lastTool))) {
        toolsCopy[toolsCopy.length - 1] = { ...lastTool, cache_control: cacheControl };
        modifiedParams.tools = toolsCopy;
      }
    }

    // Cache conversation history: mark the last message of the stable prefix so it
    // moves forward each turn. `historyCacheExcludeTrailingCount` skips trailing
    // messages a caller rebuilds every request (e.g. a reminder that's stripped and
    // re-appended each iteration) - anchoring there would never produce a cache hit.
    const messagesParam = modifiedParams.messages as unknown[] | undefined;
    if (strategy.cacheConversationHistory && Array.isArray(messagesParam) && messagesParam.length > 0) {
      const messages = [...messagesParam] as Record<string, unknown>[];
      const anchorIndex = messages.length - 1 - (strategy.historyCacheExcludeTrailingCount ?? 0);

      if (anchorIndex >= 0) {
        const anchorMsg = messages[anchorIndex];
        const msgContent = anchorMsg.content;

        // Convert content to array if needed
        let contentArray: Record<string, unknown>[] | undefined;
        if (typeof msgContent === 'string') {
          contentArray = [{ type: 'text', text: msgContent }];
        } else if (Array.isArray(msgContent)) {
          contentArray = [...msgContent] as Record<string, unknown>[];
        }

        // Mark last content block of the anchor message
        if (contentArray && contentArray.length > 0) {
          const lastBlock = contentArray[contentArray.length - 1];
          if (claim('history', hasMarker(lastBlock))) {
            contentArray[contentArray.length - 1] = { ...lastBlock, cache_control: cacheControl };
            messages[anchorIndex] = { ...anchorMsg, content: contentArray };
            modifiedParams.messages = messages;
          }
        }
      }
    }

    if (dropped.length > 0) {
      // Not fatal - the request still goes out, just with fewer breakpoints than asked for.
      // Logged because a silently degraded cache strategy is otherwise invisible: the only
      // symptom is a lower hit rate.
      const message = `[PromptCache] cache_control budget exhausted (limit ${MAX_CACHE_CONTROL_BLOCKS}); skipped breakpoints: ${dropped.join(', ')}`;
      if (logger) logger.warn(message, { dropped, limit: MAX_CACHE_CONTROL_BLOCKS });
      else console.warn(message);
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
