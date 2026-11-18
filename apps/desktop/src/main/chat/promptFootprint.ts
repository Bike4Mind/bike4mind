import { createHash } from 'node:crypto';
import type { CompletionMessage } from './completions';
import type { WireTool } from './deferredTools';

export type PromptBlock = 'loaded-tools' | 'deferred-tools' | 'system' | 'history';

export interface BlockFootprint {
  block: PromptBlock;
  bytes: number;
  estimatedTokens: number;
  sha256: string;
}

/** Diagnostic serialization estimates, not provider token counts or evidence of a cache hit. */
export function promptFootprint(messages: readonly CompletionMessage[], tools: readonly WireTool[]): BlockFootprint[] {
  const schemas = (deferred: boolean) =>
    tools
      .filter(tool => !!tool.toolSchema.defer_loading === deferred)
      .map(tool => tool.toolSchema)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks: [PromptBlock, unknown][] = [
    ['loaded-tools', schemas(false)],
    ['deferred-tools', schemas(true)],
    ['system', messages.filter(message => message.role === 'system')],
    ['history', messages.filter(message => message.role !== 'system')],
  ];
  return blocks.map(([block, value]) => {
    const serialized = JSON.stringify(value);
    return {
      block,
      bytes: Buffer.byteLength(serialized),
      estimatedTokens: Math.ceil(serialized.length / 3),
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
