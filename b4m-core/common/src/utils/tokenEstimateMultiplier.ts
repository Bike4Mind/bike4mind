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
const CLAUDE_4_7_PLUS_MULTIPLIER = 1.5;
// Opus/Sonnet 4.5 and 4.6, Haiku 4.5: 1.10x (prose) to 1.46x (code).
const CLAUDE_4_5_MULTIPLIER = 1.09;

// Matches native ids (claude-opus-4-7), Bedrock ids (global.anthropic.claude-sonnet-5,
// us.anthropic.claude-haiku-4-5-20251001-v1:0) and catalog ids alike. The minor version is one or two
// digits so a date suffix (claude-sonnet-4-20250514) is not read as one.
const CLAUDE_FAMILY_VERSION = /(?:^|\.)claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=$|[-:])/;

/**
 * Factor to scale a cl100k_base token count by for `modelId`. 1 for anything unmeasured: non-Claude
 * models, Claude before 4.5 (retired on Bedrock, could not be measured), and Fable (Bedrock rejects it
 * under the account's data-retention mode). Claude releases after 5.5 inherit the newest factor on the
 * assumption they keep its tokenizer; [BILLING_DRIFT] flags it if one does not.
 */
export function tokenEstimateMultiplier(modelId: string | undefined): number {
  const match = modelId?.match(CLAUDE_FAMILY_VERSION);
  if (!match) return 1;

  const version = Number(match[1]) + Number(match[2] ?? 0) / 10;
  if (version >= 4.7) return CLAUDE_4_7_PLUS_MULTIPLIER;
  if (version >= 4.5) return CLAUDE_4_5_MULTIPLIER;
  return 1;
}
