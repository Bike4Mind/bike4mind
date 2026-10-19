const SECONDS = String.raw`\d+(?:\.\d+)?`;

/**
 * Regex source for the timing marker Lyria puts before each sung line: empty (`[:]`) or the `[start:end]` timing in
 * seconds (`[3.4:6.9]`). A source string, not a RegExp, so each consumer adds its own anchors and flags.
 */
export const LYRIC_LINE_TIMING_SOURCE = String.raw`\[(?:${SECONDS}:${SECONDS}|:)\]`;
