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

/**
 * Does this block already carry a marker? Re-marking one costs no budget.
 *
 * Tests the VALUE, not just key presence: a block carrying an explicit
 * `cache_control: undefined` is not a marker as far as the provider is concerned, and counting
 * it would spend budget on nothing and drop a breakpoint we could have kept.
 */
function hasMarker(block: unknown): boolean {
  return !!block && typeof block === 'object' && !!(block as Record<string, unknown>).cache_control;
}

/** Where the markers on a request sit. Kept per-location so an over-budget request is diagnosable. */
interface MarkerCensus {
  tools: number;
  system: number;
  messages: number;
  total: number;
}

/**
 * Markers already on the request. Callers upstream attach their own before this runs -
 * `bedrockBackend/anthropic.ts` marks each system block flagged `cache: true` (the mid-stack
 * shareable-prefix breakpoint) - so this adapter's budget is whatever they left, not the full four.
 */
function censusMarkers(params: Record<string, unknown>): MarkerCensus {
  const tools = Array.isArray(params.tools) ? params.tools.filter(hasMarker).length : 0;
  const system = Array.isArray(params.system) ? params.system.filter(hasMarker).length : 0;
  let messages = 0;
  if (Array.isArray(params.messages)) {
    for (const message of params.messages) {
      const content = (message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content)) messages += content.filter(hasMarker).length;
    }
  }
  return { tools, system, messages, total: tools + system + messages };
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
    const inbound = censusMarkers(modifiedParams);
    let budget = MAX_CACHE_CONTROL_BLOCKS - inbound.total;
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

    const outbound = censusMarkers(modifiedParams);

    // Two distinct situations, and the difference matters:
    //
    // 1. Budget exhausted (dropped.length > 0) - this adapter deliberately skipped a breakpoint
    //    to stay legal. Not fatal; the request goes out with a weaker cache strategy, whose only
    //    other symptom would be a lower hit rate.
    // 2. Already over the cap on arrival (outbound.total > MAX) - upstream alone exceeded the
    //    ceiling, so there is nothing this adapter can subtract and the provider WILL reject the
    //    request. That is a defect in whoever attached them, and the census names where they sit
    //    so the next occurrence is diagnosable rather than a bare ValidationException. This is
    //    the case the original incident hit and could not be accounted for from code reading, so
    //    it is logged loudly rather than assumed impossible.
    // Always report the census, not only on the exceptional paths. The incident this cap was
    // written for could not be explained from code reading - the known sources sum to four, not
    // five - and a request is only diagnosable while it is still in hand. At debug level this is
    // the record that identifies the unaccounted-for marker the first time it recurs.
    const census = { inbound, outbound, limit: MAX_CACHE_CONTROL_BLOCKS };
    if (logger) logger.debug('[PromptCache] cache_control census', census);

    if (outbound.total > MAX_CACHE_CONTROL_BLOCKS) {
      const message = `[PromptCache] request exceeds the ${MAX_CACHE_CONTROL_BLOCKS}-block cache_control limit on arrival (${outbound.total}); the provider will reject it`;
      const detail = { inbound, outbound, limit: MAX_CACHE_CONTROL_BLOCKS };
      if (logger) logger.error(message, detail);
      else console.error(message, JSON.stringify(detail));
    } else if (dropped.length > 0) {
      const message = `[PromptCache] cache_control budget exhausted (limit ${MAX_CACHE_CONTROL_BLOCKS}); skipped breakpoints: ${dropped.join(', ')}`;
      const detail = { dropped, inbound, outbound, limit: MAX_CACHE_CONTROL_BLOCKS };
      if (logger) logger.warn(message, detail);
      else console.warn(message, JSON.stringify(detail));
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
