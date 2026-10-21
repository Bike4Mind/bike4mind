import { describe, expect, it } from 'vitest';
import { CliCompletionChunkAction } from './actions';
import { buildCompletionStreamEvent } from '../utils/sseEvents';

const frame = (chunk: unknown) => ({ action: 'cli_completion_chunk', requestId: 'req-1', chunk });
const block = { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: {} };

describe('CliCompletionChunkAction chunk', () => {
  it('accepts the provider_block frame buildCompletionStreamEvent builds', () => {
    const chunk = buildCompletionStreamEvent([], { providerBlock: { provider: 'anthropic', block } });
    expect(CliCompletionChunkAction.parse(frame(chunk)).chunk).toEqual({
      type: 'provider_block',
      provider: 'anthropic',
      block,
    });
  });

  it('still accepts a content frame', () => {
    const chunk = buildCompletionStreamEvent(['hi'], { outputTokens: 1 });
    expect(CliCompletionChunkAction.safeParse(frame(chunk)).success).toBe(true);
  });

  it('rejects a provider_block from an unknown provider or without a block', () => {
    expect(
      CliCompletionChunkAction.safeParse(frame({ type: 'provider_block', provider: 'openai', block })).success
    ).toBe(false);
    expect(CliCompletionChunkAction.safeParse(frame({ type: 'provider_block', provider: 'anthropic' })).success).toBe(
      false
    );
  });
});
