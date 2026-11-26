/**
 * A reasoning model spent its whole output budget thinking and produced no answer
 * (finish_reason: length). The same budget fails the same way, so callers must not retry it.
 * The message keeps the "output budget was exhausted" phrase that log searches and tests match.
 */
export class OutputBudgetExhaustedError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string
  ) {
    super(
      `${provider} returned no content for ${model}: the output budget was exhausted before any answer was produced (finish_reason: length). Raise maxTokens or lower the reasoning effort.`
    );
    this.name = 'OutputBudgetExhaustedError';
  }
}

/**
 * The stream closed with no finish reason and nothing usable. Transient, so worth one retry.
 * The message must not say "aborted", "overloaded" or "timeout": the fallback predicates match those.
 */
export class StreamEndedWithoutFinishError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string
  ) {
    super(`${provider} returned no content for ${model} (finish_reason: unknown).`);
    this.name = 'StreamEndedWithoutFinishError';
  }
}

/**
 * The turn ended normally (terminal event received) after streaming only a reasoning block: no
 * displayed text and no tool call. Usually a one-off sampling outcome, so worth one same-model retry
 * and then the fallback chain. Distinct from a stall (an LlmTimeoutError or "stream timeout" message)
 * and from the deterministic empty turn left by the max-tool-calls cap, which must not be retried.
 * The message must not say "aborted", "overloaded" or "timeout": the fallback predicates match those.
 */
export class HiddenReasoningOnlyEmptyError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    message: string
  ) {
    super(message);
    this.name = 'HiddenReasoningOnlyEmptyError';
  }
}

/** Match by name as well, so a second bundled copy of the class still counts. */
export function isOutputBudgetExhaustedError(error: unknown): error is OutputBudgetExhaustedError {
  return (
    error instanceof OutputBudgetExhaustedError ||
    (error instanceof Error && error.name === 'OutputBudgetExhaustedError')
  );
}

export function isStreamEndedWithoutFinishError(error: unknown): error is StreamEndedWithoutFinishError {
  return (
    error instanceof StreamEndedWithoutFinishError ||
    (error instanceof Error && error.name === 'StreamEndedWithoutFinishError')
  );
}

export function isHiddenReasoningOnlyEmptyError(error: unknown): error is HiddenReasoningOnlyEmptyError {
  return (
    error instanceof HiddenReasoningOnlyEmptyError ||
    (error instanceof Error && error.name === 'HiddenReasoningOnlyEmptyError')
  );
}
