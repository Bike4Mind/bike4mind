import { createHash } from 'node:crypto';
import { estimateTextTokens } from '@shared/contextLimit';

export type PromptBlock =
  'system' | 'project' | 'skills' | 'tool-state' | 'loaded-tools' | 'deferred-tools' | 'history';

/** Content fingerprints, not cache-hit evidence. Use sanitized fixtures for exported reports. */
export function promptFootprint(blocks: Partial<Record<PromptBlock, string>>) {
  return Object.entries(blocks).map(([block, text]) => ({
    block: block as PromptBlock,
    characters: text.length,
    estimatedTokens: estimateTextTokens(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  }));
}
