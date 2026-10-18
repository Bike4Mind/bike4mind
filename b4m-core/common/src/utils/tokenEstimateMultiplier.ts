import { parseClaudeModelId, type ClaudeModelFamily } from '../claudeModelId';

/**
 * The local token estimate counts every non-OpenAI model with tiktoken's cl100k_base, because tiktoken
 * has no other vendor's encoding (see TiktokenTokenizer in @bike4mind/utils). Claude's tokenizers spend
 * more tokens on the same text, so the raw count under-states Claude input. These multipliers scale it
 * back up to the model's own tokenizer.
 *
 * Measured 2026-10-01 against Bedrock input-token usage on 8 KB prose, markdown, TypeScript and JSON
 * samples. Each multiplier is the smallest ratio across those samples, rounded down, so a scaled estimate
 * stays a lower bound: it cannot over-reserve credits or reject a turn that actually fits.
 */
// Opus 4.7, 4.8, 5, 5.5 and Sonnet 5, 5.5 all measured identically: 1.51x (JSON) to 2.09x (code).
// Haiku 5.5 is NOT measured: it inherits this factor on the assumption it shares the 4.7+ tokenizer.
const CLAUDE_4_7_PLUS_MULTIPLIER = 1.5;
// Opus/Sonnet 4.5 and 4.6, Haiku 4.5: 1.10x (prose) to 1.46x (code).
const CLAUDE_4_5_MULTIPLIER = 1.09;

const MEASURED_FAMILIES: ReadonlySet<ClaudeModelFamily> = new Set(['opus', 'sonnet', 'haiku']);

/**
 * Factor to scale a cl100k_base token count by for `modelId`. 1 for anything unmeasured: non-Claude
 * models, Claude before 4.5 (retired on Bedrock, could not be measured), and Fable (Bedrock rejects it
 * under the account's data-retention mode). Claude releases after 5.5 inherit the newest factor on the
 * assumption they keep its tokenizer; [BILLING_DRIFT] flags it if one does not.
 */
export function tokenEstimateMultiplier(modelId: string | undefined): number {
  const parsed = modelId ? parseClaudeModelId(modelId) : null;
  if (!parsed || !MEASURED_FAMILIES.has(parsed.family)) return 1;

  // Compared as (major, minor), not as a decimal: 4-10 is newer than 4-7, but 4.10 < 4.7.
  const { major } = parsed;
  const minor = parsed.minor ?? 0;
  if (major > 4 || (major === 4 && minor >= 7)) return CLAUDE_4_7_PLUS_MULTIPLIER;
  if (major === 4 && minor >= 5) return CLAUDE_4_5_MULTIPLIER;
  return 1;
}

// Chars per token for the streamed-output estimate. Deliberately its own constant, not the
// retrieval-side CHARS_PER_TOKEN_SERVE_BOUND: that one tunes chunk size, and retuning it must not
// silently change what an aborted call bills. The value matches the serve bound today.
const CHARS_PER_TOKEN_OUTPUT_ESTIMATE = 6;

/**
 * Approximately a lower-bound token count for `chars` characters of streamed model output, for a call
 * whose stream was cut short before the provider reported its output tokens (Anthropic sends them only
 * on the final message_delta). CHARS_PER_TOKEN_OUTPUT_ESTIMATE bounds chars per cl100k token and
 * tokenEstimateMultiplier a lower bound on the model's tokens per cl100k token, so for the model's
 * own text the product under-bills rather than over-bills. Callers that count wrapper markup in `chars`
 * (the CLI path counts <think> markers and escaped reasoning) can overshoot slightly.
 */
export function estimateStreamedOutputTokens(chars: number, modelId: string | undefined): number {
  if (!(chars > 0)) return 0;
  return Math.max(1, Math.floor((chars / CHARS_PER_TOKEN_OUTPUT_ESTIMATE) * tokenEstimateMultiplier(modelId)));
}
