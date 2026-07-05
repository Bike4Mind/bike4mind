/**
 * LLM runtime knobs forwarded from the client are spread into the
 * `ReActAgent` constructor only when the client actually selected a value.
 * Passing `undefined` explicitly would clobber the agent's built-in defaults
 * (which rely on `?? default` fallbacks).
 *
 * `thinking` is the strict case: the client LLM store ships a baseline
 * `{ enabled: false, budget_tokens: 16000 }` on every dispatch. Forwarding
 * that into the checkpoint surfaced as a `structuredClone()` failure
 * ("Cannot transfer object of unsupported type") in `ReActAgent.toCheckpoint()`
 * for some model permutations. So we only spread `thinking` when the user
 * actively opted into extended reasoning (`enabled === true`).
 *
 * Extracted into its own pure helper so the conditional spread can be
 * unit-tested directly - the gate previously lived inline in `processExecution`
 * with zero coverage.
 */
export function buildReActAgentRuntimeConfig(execution: {
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: boolean; budget_tokens?: number };
}): {
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: true; budget_tokens: number };
} {
  return {
    ...(execution.temperature !== undefined && { temperature: execution.temperature }),
    ...(execution.maxTokens !== undefined && { maxTokens: execution.maxTokens }),
    ...(execution.thinking?.enabled && {
      thinking: {
        enabled: true as const,
        budget_tokens: execution.thinking.budget_tokens ?? 16000,
      },
    }),
  };
}
