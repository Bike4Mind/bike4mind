/**
 * How much of the input window attached-file content may claim, at the two stages that decide it.
 *
 * They are separate stages and the ordering between them is load-bearing: EXTRACTION decides how much
 * of a file is read off disk and parsed at all, ASSEMBLY then trims an already-extracted set to fit.
 * Extraction being the SMALLER of the two is what makes the assembly floor meaningful; when extraction
 * binds first, raising the floor buys nothing a user can see, which is exactly the bug these functions
 * were pulled out of two files to make testable.
 *
 * The relationship is not uniform across window sizes, and the comment this replaced overstated it.
 * Extraction sets aside a flat reserve while assembly holds back a percentage buffer, so above roughly
 * 80k tokens the buffer overtakes the reserve and extraction reads slightly MORE than the floor
 * guarantees. That is tolerable rather than a defect: the floor is a floor, not a cap, so on a large
 * window content usually gets far more than it, and the excess is trimmed with a declared notice in the
 * rare case it is not. What must hold everywhere is `attachedContentBudgetsAgree`.
 *
 * Pure arithmetic, no I/O and no model lookups, so a caller that only wants to know whether a file
 * will fit does not have to build a completion to find out.
 */

import { CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS, type ModelInfo } from '@bike4mind/common';

/**
 * Usable input window: the context window less the output this request will reserve, less a safety
 * buffer. Deliberately NOT clamped at zero - the caller's empty-prompt guard depends on seeing a
 * non-positive budget for a genuinely misconfigured text model.
 *
 * Image and video models return media rather than tokens, so their max_tokens is a prompt-length limit
 * and is never reserved as output - most media rows set it equal to contextWindow, Gemini's image rows
 * set it lower, and either way subtracting it would leave no room for the prompt itself. Several
 * callers need this figure - the assembly budget, the verbatim-history window, and the extraction
 * budget below - and they must not drift apart.
 *
 * The static catalog tables are held to the positive-budget property by
 * modelCatalogInputBudget.test.ts, and a discovered claim that would break it for a TEXT row is
 * refused in modelDiscoveryService/catalogWrite. A media row whose window arrives as 0 from a feed
 * falls back the same as an absent one, below - two provider sources report it that way on purpose to
 * mean "not applicable" (see ModelCatalogTypes.ts), not a real zero-token budget.
 *
 * The buffer figure is imported rather than redeclared here: common owns it, and two copies of the
 * same number is the drift that made it a shared export in the first place.
 */
export function safeInputWindow(
  modelInfo: Pick<ModelInfo, 'contextWindow' | 'max_tokens' | 'type'>,
  requestedMaxTokens: number,
  safetyBuffer = CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS
): number {
  const returnsMedia = modelInfo.type === 'image' || modelInfo.type === 'video';
  // A text row keeps 0 literal: a misconfigured text row is exactly what the caller's empty-prompt
  // guard exists to catch, and that has to see a non-positive budget to fire.
  const rawContextWindow = modelInfo.contextWindow;
  const contextLimit = returnsMedia && !rawContextWindow ? 200000 : (rawContextWindow ?? 200000);
  const modelMaxOutput = modelInfo.max_tokens ?? 16384;
  const reservedOutput = returnsMedia ? 0 : Math.min(requestedMaxTokens, modelMaxOutput);
  return contextLimit - reservedOutput - safetyBuffer;
}

/**
 * Floor for the context-overflow buffer, used when 5% of the context window is under 1000 tokens.
 * Covers token-estimation error (10-20% between estimate and tokenizer), special-token and
 * formatting overhead (role tags, separators), and output headroom.
 */
export const MIN_TOKEN_BUFFER = 1000;

/**
 * Fraction of the context window reserved as buffer (5%).
 * Covers token-count drift between estimate and encoder and special tokens (BOS, EOS, role
 * markers), and keeps input+output from exactly hitting the context limit.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.05;

/**
 * Smallest share of the token budget an explicitly attached file is guaranteed when a finite
 * historyCount is set. History used to have absolute priority here, so a long conversation silently
 * pushed the file the user just attached out of context entirely and the model answered as though no
 * file existed.
 *
 * 0.35 is the largest share that still leaves history the clear majority, which the user did not ask
 * to give up. A fraction rather than a token count, so the reserve can never exceed the budget on a
 * small context window. The exact figure is not load-bearing: unused reserve flows back to history, so
 * over-reserving costs nothing and this only binds when content genuinely wants more.
 *
 * Taken against the budget BEFORE system instructions are charged to it. Against the remainder, a
 * heavy system stack on a small window left the file a third of what the model could have carried.
 */
export const MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION = 0.35;

/**
 * Share of the usable input window attached-file content may be EXTRACTED into, once a reserve for
 * system instructions is set aside. Held below the assembly floor on purpose: extraction estimates at
 * CHARS_PER_TOKEN while assembly re-counts with the real tokenizer, so the headroom keeps anything
 * extracted from being dropped again downstream.
 */
export const ATTACHED_CONTENT_EXTRACTION_SHARE = 0.35;

/**
 * Floor for the extraction budget, as a share of the raw input window, for when the system reserve
 * would otherwise drive it to zero.
 *
 * Load-bearing rather than defensive: a budget of 0 does not mean "send nothing" to
 * processFabFilesServer, it means "no budget given", which restores a flat per-file cap applied once
 * per file - so three files would be handed more content than the whole window.
 */
export const MIN_ATTACHED_CONTENT_EXTRACTION_SHARE = 0.15;

/**
 * Ceiling on the system-instruction reserve, as a share of the usable input window.
 *
 * The reserve is a flat token count sized for a large window. Subtracted whole from an 8k-class window
 * it consumed most of the budget, collapsing the extraction formula onto its emergency floor: a 4k
 * character file was head-sliced to about 2.6k characters before assembly ever saw it, and no change to
 * the assembly floor could recover it. Capping the reserve proportionally leaves large windows
 * untouched - a 4000-token reserve is already well under 30% of anything above ~13k - and keeps the
 * small ones usable.
 */
export const EXTRACTION_SYSTEM_RESERVE_MAX_SHARE = 0.3;

/**
 * Tokens of attached-file content that may be extracted this turn, for the whole turn rather than per
 * file (the caller divides by the file count).
 *
 * `systemPromptReserve` is the caller's flat estimate of its own system stack; it is bounded here
 * rather than at its definition because it has another consumer that sizes how much history to FETCH,
 * where shrinking it would pull in more history to compete with the file.
 */
export function attachedContentExtractionBudget(maxSafeInputTokens: number, systemPromptReserve: number): number {
  const boundedReserve = Math.min(
    systemPromptReserve,
    Math.floor(maxSafeInputTokens * EXTRACTION_SYSTEM_RESERVE_MAX_SHARE)
  );
  // Outer clamp is not redundant: on a tiny context window maxSafeInputTokens is itself negative
  // (contextLimit - output cap - buffer), so both inner terms are negative.
  return Math.max(
    0,
    Math.max(
      Math.floor(maxSafeInputTokens * MIN_ATTACHED_CONTENT_EXTRACTION_SHARE),
      Math.floor((maxSafeInputTokens - boundedReserve) * ATTACHED_CONTENT_EXTRACTION_SHARE)
    )
  );
}

/** The buffer buildAndSortMessages holds back before dividing the input window. */
export function assemblyTokenBuffer(maxInputTokens: number): number {
  return Math.max(MIN_TOKEN_BUFFER, Math.floor(maxInputTokens * TOKEN_BUFFER_PERCENTAGE));
}

/**
 * Tokens attached content is guaranteed at ASSEMBLY on a windowed request.
 *
 * Ignores the user's prompt, which the real builder also subtracts, so this reads slightly HIGH - the
 * optimistic direction. A caller comparing a file against it right at the boundary should allow for the
 * prompt; the checks here carry hundreds of tokens of margin, well clear of one.
 */
export function attachedContentAssemblyFloor(maxInputTokens: number): number {
  const preSystemBudget = maxInputTokens - assemblyTokenBuffer(maxInputTokens);
  if (!(preSystemBudget > 0)) return 0;
  return Math.floor(preSystemBudget * MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION);
}

/**
 * Whether a window can carry attached content coherently: something is read off disk, and no more is
 * read than assembly could deliver even in its best case.
 *
 * Deliberately bounded by the whole pre-system budget rather than by the floor. Requiring
 * `extraction <= floor` would fail every window above ~80k for the buffer-versus-reserve reason above,
 * and satisfying it would mean cutting what large models extract, which is a different decision. This
 * is the weaker property that has to hold everywhere: extract nothing undeliverable, and never
 * extract nothing at all.
 */
export function attachedContentBudgetsAgree(maxSafeInputTokens: number, systemPromptReserve: number): boolean {
  const extraction = attachedContentExtractionBudget(maxSafeInputTokens, systemPromptReserve);
  const deliverable = maxSafeInputTokens - assemblyTokenBuffer(maxSafeInputTokens);
  return extraction > 0 && extraction <= deliverable;
}
