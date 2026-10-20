import type { Logger } from '@bike4mind/observability';

export type ToolRoundEntry = {
  model: string;
  /** 0-based index of the tool-loop round within one chat turn. */
  round: number;
  /** Null on non-streaming paths, where there is no first chunk to wait for. */
  msToFirstChunk: number | null;
  /** Provider call start until the response/stream ended, before any tools ran. */
  modelMs: number;
  /** Provider call start until the round's tool batch finished (or the terminal response ended). */
  roundMs: number;
  /** Time since the first round of this chat turn started. */
  sinceRequestMs: number;
  stopReason: string | null;
  tools: { name: string; resultChars: number }[];
};

type ToolRoundOutcome = { ok: boolean; name: string; result?: unknown };

export const TOOL_ROUND_LOG_PREFIX = '\u23F1\uFE0F [ToolRound]';

/** Size of a tool result in characters. Never returns, or retains, the content itself. */
export const toolResultChars = (result: unknown): number => {
  try {
    return String(result).length;
  } catch {
    return 0;
  }
};

/** Names and sizes only: tool arguments and result content must never reach the log. */
export const summarizeToolOutcomes = (outcomes: readonly ToolRoundOutcome[]): ToolRoundEntry['tools'] =>
  outcomes.map(outcome => ({
    name: outcome.name,
    resultChars: outcome.ok ? toolResultChars(outcome.result) : 0,
  }));

/** With `executeTools: false` the caller drives the loop: tool rounds log nothing and terminal rounds log `round: 0`.
 * A model fallback starts a fresh `complete()`, so `round` and `sinceRequestMs` restart at 0. */
export const logToolRound = (logger: Pick<Logger, 'info' | 'warn'>, entry: ToolRoundEntry): void => {
  // The one deliberate swallow: observability must never break a chat turn.
  try {
    logger.info(TOOL_ROUND_LOG_PREFIX, entry);
  } catch (error) {
    try {
      logger.warn(
        `${TOOL_ROUND_LOG_PREFIX} failed to log round: ${error instanceof Error ? error.message : 'unknown'}`
      );
    } catch {
      // A logger that throws on warn too has nowhere left to report to.
    }
  }
};
