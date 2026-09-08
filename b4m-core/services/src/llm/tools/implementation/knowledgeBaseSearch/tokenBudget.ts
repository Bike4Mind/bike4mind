import type { Logger } from '@bike4mind/observability';
import type { ITokenizer } from '@bike4mind/utils';
import { defangRetrievedContent } from '../../../../dataLakeService/renderRetrievedContentBlock';
import type { SemanticChunkResult } from '../../../../dataLakeService/semanticDataLakeSearch';

/**
 * Cut to a budget without splitting a character. `slice` counts UTF-16 code units, so a cut at an
 * arbitrary index can land between the halves of a surrogate pair (emoji, supplementary-plane CJK)
 * and emit a lone surrogate - a corrupted final character in the text the model reads, and one that
 * survives into anything quoting the passage back. Dropping the orphaned half costs one character of
 * an already-truncated passage.
 */
export function clipToCodePointBoundary(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  const endsOnOrphanedHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return endsOnOrphanedHighSurrogate ? sliced.slice(0, -1) : sliced;
}

/**
 * The exact passage body `formatSemanticResults` emits for one result: trimmed, clipped to the
 * serve budget at a code-point boundary, defanged. Extracted so the token walk below prices what is
 * actually SERVED rather than what is stored - a 4000-char chunk clipped to 2000 costs half what its
 * raw text implies, and pricing the raw (unclipped) text would make the token budget bind at the
 * wrong breadth.
 */
export function servedPassageText(
  r: Pick<SemanticChunkResult, 'chunkText'>,
  maxChunkChars: number
): { text: string; clipped: boolean } {
  const trimmed = r.chunkText.trim();
  const overBudget = trimmed.length > maxChunkChars;
  const clipped = overBudget ? `${clipToCodePointBoundary(trimmed, maxChunkChars)}\u2026` : trimmed;
  return { text: defangRetrievedContent(clipped), clipped: overBudget };
}

/**
 * How many rank-ordered passages fit a token budget. Pure and total - costs are supplied, so every
 * boundary is directly testable without a tokenizer.
 *
 * `tokenBudget <= 0` disables the budget entirely: yields `min(maxItems, costs.length)`, the
 * pre-#1955 bound, byte for byte.
 *
 * The FIRST passage is always admitted, even if it alone exceeds the budget - a search that found
 * something must never return zero passages, which the model would otherwise read as "the library
 * holds nothing on this topic", the one outcome it cannot recover from.
 */
export function boundByTokenBudget(
  costs: readonly number[],
  opts: { tokenBudget: number; maxItems: number }
): { keptCount: number; tokensUsed: number; budgetBound: boolean } {
  const ceiling = Math.min(Math.max(opts.maxItems, 0), costs.length);
  if (opts.tokenBudget <= 0) return { keptCount: ceiling, tokensUsed: 0, budgetBound: false };

  let tokensUsed = 0;
  let keptCount = 0;
  let budgetBound = false;
  for (let i = 0; i < ceiling; i++) {
    if (keptCount > 0 && tokensUsed + costs[i] > opts.tokenBudget) {
      budgetBound = true;
      break;
    }
    tokensUsed += costs[i];
    keptCount++;
  }
  return { keptCount, tokensUsed, budgetBound };
}

/**
 * Async wrapper: prices each passage with the shared tokenizer (NO model id - a deterministic
 * cl100k_base proxy count, not a billed figure; passing an unknown embedding/chat model id would
 * warn on every passage on a non-tiktoken-known deployment), then applies the pure walk above. A
 * tokenizer failure never costs a good search: it warns once and degrades to a passage-count bound,
 * the same never-lose-a-result policy `resolveSearchBudgets` uses for a settings outage.
 *
 * `fallbackCount` (defaults to `maxPassages`) is what that degrade path serves. It exists because
 * `maxPassages` may already be the BUDGET-WIDENED ceiling (`resolvePassageCeiling` opens it to
 * `KB_SEARCH_MAX_RESULTS` once a token budget is configured, expecting the walk below to bound it
 * back down) - which only makes sense WITH working token accounting. Falling back to that same wide
 * ceiling when pricing itself just failed would serve full-size passages with no cost control at
 * all, in exactly the failure mode a budget exists to guard against. Callers with no such
 * distinction (the disabled-budget path, where `maxPassages` is already the plain default) can omit
 * it.
 */
export async function boundPassagesByTokenBudget(
  results: readonly SemanticChunkResult[],
  opts: {
    tokenBudget: number;
    maxPassages: number;
    fallbackCount?: number;
    maxChunkChars: number;
    tokenizer: Pick<ITokenizer, 'countTokens'>;
    logger?: Logger;
  }
): Promise<{ kept: SemanticChunkResult[]; tokensUsed: number; budgetBound: boolean }> {
  const boundTo = (count: number) => ({
    kept: results.slice(0, Math.max(count, 0)),
    tokensUsed: 0,
    budgetBound: false,
  });
  if (opts.tokenBudget <= 0 || results.length === 0) return boundTo(opts.maxPassages);

  // Price only what could ever be served (up to maxPassages) - the walk below never looks past
  // that ceiling either, so pricing the rest is pure waste: up to 3 searches/turn, each capable of
  // 10 candidates when a budget widens topK, but a model-supplied max_results narrows the ceiling.
  const candidates = results.slice(0, Math.max(opts.maxPassages, 0));

  let costs: number[];
  try {
    costs = await Promise.all(
      candidates.map(r => opts.tokenizer.countTokens(servedPassageText(r, opts.maxChunkChars).text))
    );
  } catch (err) {
    opts.logger?.warn?.('📚 [semantic] token-budget pricing failed; falling back to passage-count bound', err);
    return boundTo(opts.fallbackCount ?? opts.maxPassages);
  }
  const bound = boundByTokenBudget(costs, { tokenBudget: opts.tokenBudget, maxItems: opts.maxPassages });
  return { kept: candidates.slice(0, bound.keptCount), tokensUsed: bound.tokensUsed, budgetBound: bound.budgetBound };
}
