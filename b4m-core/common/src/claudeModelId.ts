export type ClaudeModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

export type ParsedClaudeModelId = {
  family: ClaudeModelFamily;
  major: number;
  /** null when the id names only a major version (`claude-opus-5`). */
  minor: number | null;
};

/** Bedrock's `[<scope>.]anthropic.` id prefix (any region or `global`), as regex source. Shared with isClaudeModelId. */
export const BEDROCK_ANTHROPIC_PREFIX = '(?:(?:[a-z-]+\\.)?anthropic\\.)?';

// `claude-<family>-<major>[-<minor>]` then an 8-digit date, a lettered suffix (`-v1:0`, `-latest`), `:`, `@`,
// `[1m]` or the end. The minor is one or two digits so a date is not read as one. Anything else after the
// version (a patch `-5-5-1`) is unreviewed and reads null, not a shorter version.
const CLAUDE_MODEL_ID = new RegExp(
  `^${BEDROCK_ANTHROPIC_PREFIX}claude-(opus|sonnet|haiku|fable|mythos)-(\\d+)(?:-(\\d{1,2}))?(?=$|[:@[]|-(?:\\d{8}(?!\\d)|[a-z]))`
);

/** Family and version of a Claude id (native, Bedrock-scoped, dated or aliased); null for any other shape. */
export function parseClaudeModelId(modelId: string): ParsedClaudeModelId | null {
  const match = CLAUDE_MODEL_ID.exec(modelId);
  if (!match) return null;
  const [, family, major, minor] = match;
  return {
    family: family as ClaudeModelFamily,
    major: Number(major),
    minor: minor === undefined ? null : Number(minor),
  };
}

/** `opus-4-5` for `claude-opus-4-5-20251101` or `global.anthropic.claude-opus-4-5-...`; null otherwise. */
export function claudeFamilyVersion(modelId: string): string | null {
  const parsed = parseClaudeModelId(modelId);
  if (!parsed) return null;
  return parsed.minor === null
    ? `${parsed.family}-${parsed.major}`
    : `${parsed.family}-${parsed.major}-${parsed.minor}`;
}
