/**
 * System-prompt variants for the eval suite's A/B testing infrastructure.
 *
 * The hypothesis driving this module: heavy prompting may constrain
 * modern frontier models (Sonnet 4.6, Opus 4.7, GPT-5) more than it
 * helps. Pi-coding-agent ships a ~15-line prompt and runs fine on the
 * same models we use. Our agent core's default is paragraphs of
 * "be proactive" / behavioral guidelines that may be redundant for
 * the model's instruction-following capacity.
 *
 * Each variant returns either:
 *  - `undefined`: don't set systemPrompt - the ReActAgent falls back
 *                 to its built-in `getSystemPrompt()` which interpolates
 *                 the current tool list and "be proactive" guidelines.
 *  - A string: explicit override that the agent uses verbatim.
 *
 * Naming conventions:
 *  - `current`: whatever the production agent core ships today.
 *               Treated as the control. Implemented as `undefined` so
 *               the agent's own logic stays authoritative - no risk
 *               of drift between this file and the live default.
 *  - `minimal`: pi-style. ~15 lines. No tool list (Anthropic's
 *               tools API passes them via the dedicated `tools`
 *               parameter; the model doesn't need them spelled out
 *               in the system prompt too).
 */

export type PromptVariant = 'current' | 'minimal';

export const PROMPT_VARIANTS: readonly PromptVariant[] = ['current', 'minimal'];

const MINIMAL_PROMPT = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files using the tools available to you.

Guidelines:
- Be concise in your responses.
- Show file paths clearly when working with files.
- When the task is done, give the user a direct answer — no recap of steps already visible in the tool history.`;

/**
 * Resolve a variant name to a system-prompt override.
 * `current` returns undefined so the agent's built-in prompt fires.
 */
export function getPromptVariant(name: PromptVariant): string | undefined {
  switch (name) {
    case 'current':
      return undefined;
    case 'minimal':
      return MINIMAL_PROMPT;
  }
}

export function isPromptVariant(name: string): name is PromptVariant {
  return (PROMPT_VARIANTS as readonly string[]).includes(name);
}
