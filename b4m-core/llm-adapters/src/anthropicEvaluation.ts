import { BadRequestError } from '@bike4mind/common';
import { assertEvaluationTextWire, assertEvaluationWireBound } from './evaluationTextWire';

const searchTools = new Set(['tool_search_tool_regex_20251119', 'tool_search_tool_bm25_20251119']);

export function assertAnthropicEvaluationWire(value: unknown, contextWindow: number): void {
  const check = (part: unknown): void => {
    if (!part || typeof part !== 'object') return;
    if (Array.isArray(part)) {
      part.forEach(check);
      return;
    }
    const record = part as Record<string, unknown>;
    if (Object.keys(record).some(key => ['image_url', 'audio', 'file_id', 'previous_response_id'].includes(key)))
      throw new BadRequestError('Unsupported evaluation media.');
    if (record.type === 'document') throw new BadRequestError('Evaluation documents are not supported.');
    if (
      typeof record.type === 'string' &&
      (searchTools.has(record.type) ||
        ['tool_search_tool_result', 'tool_search_tool_search_result', 'tool_search_tool_result_error'].includes(
          record.type
        ))
    ) {
      const { type: _type, ...rest } = record;
      Object.values(rest).forEach(check);
      return;
    }
    if (
      record.type === 'server_tool_use' &&
      !['tool_search_tool_regex', 'tool_search_tool_bm25'].includes(String(record.name))
    )
      throw new BadRequestError('Unsupported evaluation server tool.');
    if (typeof record.type === 'string' && /search/.test(record.type))
      throw new BadRequestError('Unsupported evaluation search tool.');
    if (Object.hasOwn(record, 'cache_control')) {
      const cache = record.cache_control as { type?: unknown; ttl?: unknown } | undefined;
      if (!cache || cache.type !== 'ephemeral' || (cache.ttl !== undefined && cache.ttl !== '5m' && cache.ttl !== '1h'))
        throw new BadRequestError('Unsupported evaluation cache control.');
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'type') {
        assertEvaluationTextWire({ type: child });
      } else check(child);
    }
  };
  check(value);
  const params = value as Record<string, unknown>;
  if (
    ['speed', 'inference_geo', 'service_tier', 'container', 'context_management', 'mcp_servers'].some(
      key => params[key] !== undefined
    )
  )
    throw new BadRequestError('Unsupported evaluation pricing modifier.');
  const tools = params.tools as Array<{ type?: string }> | undefined;
  if (tools?.some(tool => tool.type && !searchTools.has(tool.type) && tool.type !== 'custom'))
    throw new BadRequestError('Unsupported evaluation provider tool.');
  assertEvaluationWireBound(value, contextWindow);
}

export function anthropicEvaluationUsage(response: unknown, expectedModel: string) {
  const message = response as { model?: unknown; usage?: Record<string, unknown> };
  const usage = message.usage;
  if (message.model !== expectedModel || !usage) throw new Error('Evaluation provider identity or usage missing');
  const split = usage.cache_creation as Record<string, unknown> | undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  const write5m = split?.ephemeral_5m_input_tokens;
  const write1h = split?.ephemeral_1h_input_tokens;
  if (
    ![input, output, read, write, write5m, write1h].every(
      n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
    )
  )
    throw new Error('Evaluation cache usage classes missing or invalid');
  // Anthropic output_tokens already includes thinking; no separate thinking count is reported.
  const counts = {
    input: input as number,
    output: output as number,
    read: read as number,
    write: write as number,
    write5m: write5m as number,
    write1h: write1h as number,
  };
  if (counts.write !== counts.write5m + counts.write1h) throw new Error('Evaluation cache usage split mismatch');
  const serverUsage = usage.server_tool_use;
  if (serverUsage && typeof serverUsage === 'object' && Object.values(serverUsage).some(n => n !== 0 && n !== null))
    throw new Error('Unsupported evaluation server tool charge');
  return {
    inputTokens: counts.input + counts.read + counts.write,
    outputTokens: counts.output,
    cacheReadTokens: counts.read,
    cacheWrite5mTokens: counts.write5m,
    cacheWrite1hTokens: counts.write1h,
  };
}
