/**
 * Builds the `config` argument passed to `buildSharedTools()` for the Agent
 * Executor's two call sites (parent ReActAgent + dispatched subagent).
 *
 * Without this, both sites historically passed `config: {}`, which caused
 * `deep_research` to fall through to its built-in defaults: `GPT-4.1` analysis
 * model and the admin-settings OpenAI key - silently downgrading subagent
 * research output regardless of the user's selected model. The main chat path
 * (`ChatCompletionProcess.buildTools`) already threads `model` + `apiKeys` into
 * `config.deep_research`; this helper mirrors that shape for parity.
 *
 * Pure helper to keep the wiring unit-testable.
 */
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import type { GenerateImageToolCall } from '@bike4mind/common';
import type { BuildSharedToolsOptions } from '@bike4mind/services';

export interface BuildSubagentToolConfigInput {
  model?: string;
  apiKeyTable?: ApiKeyTable;
  /**
   * The user's selected image generation config (model, size, quality, etc),
   * forwarded from the dispatch and persisted on the AgentExecution doc.
   * Without it the `image_generation` / `edit_image` tools receive `undefined`
   * and short-circuit with "Image model selection required" - there is no
   * picker UI in a headless executor run. Omit when the user never selected
   * an image model; the tool then falls back to its built-in default
   * (`GPT_IMAGE_2`).
   */
  imageConfig?: Partial<GenerateImageToolCall>;
}

export function buildSubagentToolConfig({
  model,
  apiKeyTable,
  imageConfig,
}: BuildSubagentToolConfigInput): NonNullable<BuildSharedToolsOptions['config']> {
  return {
    deep_research: {
      model,
      apiKeys: apiKeyTable,
    },
    // Mirror the classic chat path (ChatCompletionProcess.buildTools), which
    // passes `image_generation` + `edit_image` so the tools have a model to
    // run with. Only set when imageConfig is present so a text-only run
    // doesn't carry an empty object.
    ...(imageConfig && { image_generation: imageConfig, edit_image: imageConfig }),
  };
}
