import type { ModelInfo } from '@bike4mind/common';

export const MODEL_SWITCH_BUSY_MESSAGE =
  'Agent is busy - wait for the current response to finish before switching models.';

/**
 * What to save for a picked model. A model on an Ollama found by detection also saves that host and the
 * local default, since later runs that never detect (`b4m -p`) must reach it instead of a hosted model.
 */
export function modelSavePatch(
  model: { id: string },
  config: { ollamaHost?: string },
  detectedOllama: { host: string; modelIds: ReadonlySet<string> } | null
): { defaultModel: string; ollamaHost?: string; localDefaultModel?: string } {
  const onDetectedOllama =
    detectedOllama !== null &&
    detectedOllama.modelIds.has(model.id) &&
    (!config.ollamaHost || config.ollamaHost === detectedOllama.host);
  return onDetectedOllama
    ? { defaultModel: model.id, ollamaHost: detectedOllama.host, localDefaultModel: model.id }
    : { defaultModel: model.id };
}

export interface ModelSwitchDeps {
  /** True while a response is streaming; re-read, never snapshotted. */
  isBusy: () => boolean;
  /** Persist `modelId` as the default. Must NOT touch the live session. */
  saveModel: (modelId: string) => Promise<void>;
  /** Point the live session, agent context, and LLM backend at `modelId`. */
  applyToSession: (modelId: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Side-effect layer for a `/model` switch, shared by the argument dispatcher and
 * the interactive picker so both entry points get the same guards and messages.
 *
 * A switch mutates agent.context.model and the LLM backend, and ReActAgent
 * re-reads context.model every loop iteration, so applying one mid-run would
 * split a single multi-step response across two models with inconsistent token
 * accounting. Busy is therefore checked twice: at entry, and again after the
 * save resolves, since a run can start during the save's I/O window. In that
 * late case the config write stands (it is the next-session default) but the
 * live session is left alone.
 */
export async function performModelSwitch(model: ModelInfo, deps: ModelSwitchDeps): Promise<void> {
  if (deps.isBusy()) {
    deps.log(MODEL_SWITCH_BUSY_MESSAGE);
    return;
  }

  try {
    await deps.saveModel(model.id);

    if (deps.isBusy()) {
      deps.log(
        `Saved ${model.name} (${model.id}) as the default, but a response started while saving - ` +
          'this session keeps its current model.'
      );
      return;
    }

    deps.applyToSession(model.id);
    deps.log(`✅ Switched to ${model.name} (${model.id})`);
  } catch (error) {
    deps.error(`Failed to switch model: ${error instanceof Error ? error.message : String(error)}`);
  }
}
