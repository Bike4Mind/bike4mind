import { getEmbeddingModelCost } from '@bike4mind/common';
import { categoryForFile } from '@client/app/utils/folderTreeParser';

// ~3 bytes/token, below the ~4 bytes/token this repo's own chunker measures for prose - kept
// deliberately low so the estimate rounds UP and over-states cost, never under-states it. A
// warning built on this heuristic should always err toward "more cautious than reality".
export const ESTIMATE_BYTES_PER_TOKEN = 3;

/**
 * Fraction of a file's raw bytes that becomes embeddable text, per FILE_TYPE_MAP category.
 * Each is biased HIGH (over-estimates extracted text) for the same reason as the bytes/token
 * ratio: an advisory warning must never under-state cost. Word/Excel/PowerPoint are zip
 * containers (mostly non-text overhead); PDF text density varies widely; images yield 0 -
 * nothing in the ingest pipeline OCRs them today (revisit this if that changes).
 */
const TEXT_YIELD_BY_CATEGORY: Record<string, number> = {
  Text: 1.0,
  Markdown: 1.0,
  Code: 1.0,
  CSV: 1.0,
  JSON: 1.0,
  HTML: 1.0,
  Word: 0.6,
  Excel: 0.6,
  PowerPoint: 0.6,
  PDF: 0.4,
  Image: 0,
  Other: 1.0,
};

/**
 * Advisory-only token estimate from file size alone (no text extraction happens client-side -
 * see EmbeddingBudgetEstimate's doc comment for why). Always rounds up: over-estimating is the
 * safe direction for a budget warning.
 */
export function estimateEmbeddingTokens(files: { name: string; size: number }[]): number {
  return files.reduce((sum, f) => {
    const category = categoryForFile(f.name);
    const yieldFraction = TEXT_YIELD_BY_CATEGORY[category] ?? 1.0;
    return sum + Math.ceil((f.size * yieldFraction) / ESTIMATE_BYTES_PER_TOKEN);
  }, 0);
}

/** Thin wrapper over getEmbeddingModelCost, guarded against calling it with 0 tokens (which
 * would otherwise console.error on an unpriced model for a no-op estimate). */
export function estimateEmbeddingCostUsd(tokens: number, model: string): number {
  if (tokens <= 0) return 0;
  return getEmbeddingModelCost(model, tokens);
}
