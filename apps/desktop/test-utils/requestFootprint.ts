import { createHash } from 'node:crypto';
import { estimateTextTokens } from '../src/shared/contextLimit';
import type { CompletionMessage } from '../src/main/chat/completions';
import type { WireTool } from '../src/main/chat/deferredTools';

export type PromptBlock = 'loaded-tools' | 'deferred-tools' | 'system' | 'history' | 'tool-changes';

export interface BlockFootprint {
  block: PromptBlock;
  bytes: number;
  estimatedTokens: number;
  sha256: string;
}

/**
 * Diagnostic serialization estimates, not provider token counts or evidence of a cache hit.
 * `bytes` is UTF-8 length; `estimatedTokens` uses Desktop's shared per-script estimator.
 */
export function promptFootprint(messages: readonly CompletionMessage[], tools: readonly WireTool[]): BlockFootprint[] {
  const schemas = (deferred: boolean) =>
    tools
      .filter(tool => !!tool.toolSchema.defer_loading === deferred)
      .map(tool => tool.toolSchema)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks: [PromptBlock, unknown][] = [
    ['loaded-tools', schemas(false)],
    ['deferred-tools', schemas(true)],
    ['system', messages.filter(message => message.role === 'system' && typeof message.content === 'string')],
    ['history', messages.filter(message => message.role !== 'system')],
    ['tool-changes', messages.filter(message => message.role === 'system' && Array.isArray(message.content))],
  ];
  return blocks.map(([block, value]) => {
    const serialized = JSON.stringify(value);
    return {
      block,
      bytes: Buffer.byteLength(serialized),
      estimatedTokens: estimateTextTokens(serialized),
      sha256: createHash('sha256').update(serialized).digest('hex'),
    };
  });
}

export function changedPromptBlocks(
  before: readonly BlockFootprint[],
  after: readonly BlockFootprint[]
): PromptBlock[] {
  return after
    .filter(next => before.find(previous => previous.block === next.block)?.sha256 !== next.sha256)
    .map(next => next.block);
}
