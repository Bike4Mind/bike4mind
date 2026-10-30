import {
  estimateFit,
  estimateFitFromSize,
  memoryBudgets,
  type FitPlan,
  type FitRuntime,
  type HardwareProfile,
  type ModelArch,
} from '@bike4mind/common';
import { formatMemory, type FitLevel, type MachineView, type ModelFit } from '@shared/models';

// Desktop chats through Ollama with one slot; its KV type is daemon-wide, so plan the f16 default.
const OLLAMA_RUNTIME: FitRuntime = { kind: 'ollama', flashAttn: 'auto', slots: 1, draftMax: 0 };
// Past this share of the budget a resident model is rated tight: other apps can push it into swap.
const TIGHT_SHARE = 0.9;
const CPU_NOTE = 'No GPU memory was detected, so this assumes it runs on the CPU.';

type Plan = FitPlan & { fits: boolean };

export function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

// What the runtime allocates; the estimator's margin decides the verdict but is not memory the model uses.
const shownNeed = (plan: Plan) => formatMemory(plan.memory.totalBytes);

function plan(arch: ModelArch, weightsBytes: number, hardware: HardwareProfile, context: number, mmproj = 0): Plan {
  const fit = estimateFit({
    model: { arch, weightsBytes, mmprojBytes: mmproj },
    hardware,
    mode: 'chat',
    runtime: OLLAMA_RUNTIME,
    context: Math.min(Math.max(1, Math.round(context)), arch.contextMax),
  });
  if (!fit.requested) throw new Error('estimateFit returned no plan for the requested context');
  return fit.requested;
}

function describe(plan: Plan, cpuOnly: boolean): { level: FitLevel; detail: string } {
  const need = shownNeed(plan);
  const budget = formatMemory(plan.memory.budgetBytes);
  const ctx = `the ${contextLabel(plan.context)} context chat will use`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  if (!plan.fits)
    return {
      level: 'too-large',
      detail: `Needs about ${need} at ${ctx}, more than the ${budget} a model can use here.${note}`,
    };
  if (plan.placement === 'expert-offload' || plan.placement === 'layer-offload')
    return {
      level: 'tight',
      detail: `Fits at ${ctx} only with part of it in system RAM, so replies are slower: about ${need} in all.`,
    };
  const where = cpuOnly ? 'in memory' : 'in GPU memory';
  const usage = `about ${need} of the ${budget} a model can use here`;
  if (plan.memory.totalBytes + plan.memory.marginBytes > plan.memory.budgetBytes * TIGHT_SHARE)
    return { level: 'tight', detail: `Only just fits ${where} at ${ctx}: ${usage}.${note}` };
  return { level: 'fits', detail: `Fits ${where} at ${ctx}: ${usage}.${note}` };
}

/** The shared estimator's plan for an Ollama load at `context`, the one chatContextTokens (main/chat/localContext.ts) says chat requests. */
export function fitFromArch(
  arch: ModelArch,
  weightsBytes: number,
  hardware: HardwareProfile,
  context: number,
  options: { mmprojBytes?: number } = {}
): ModelFit {
  const planned = plan(arch, weightsBytes, hardware, context, options.mmprojBytes);
  return { ...describe(planned, memoryBudgets(hardware).cpuOnly), basis: 'arch', context: planned.context };
}

/**
 * The shared size-only verdict (estimateFitFromSize) worded for the Models screen. `limitKnown: false` means chat may
 * send less than `context`.
 */
export function fitFromSize(
  sizeBytes: number,
  hardware: HardwareProfile,
  context: number,
  options: { limitKnown?: boolean } = {}
): ModelFit {
  const { level, needBytes, budgetBytes, offloadBytes, cpuOnly } = estimateFitFromSize(sizeBytes, hardware, context);
  const ctx =
    options.limitKnown === false
      ? `the context chat will use (up to ${contextLabel(context)})`
      : `the ${contextLabel(context)} context chat will use`;
  const rough = `Rough estimate from the file size: about ${formatMemory(needBytes)} before the memory for ${ctx}`;
  const budget = `the ${formatMemory(budgetBytes)} a model can use here`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  const detail =
    level === 'too-large'
      ? `${rough}, more than ${budget}.${note}`
      : offloadBytes > 0
        ? `${rough}, more than ${budget}, so part of it runs from system RAM and replies are slower.`
        : level === 'tight'
          ? `${rough}, close to ${budget}.${note}`
          : `${rough}, of ${budget}.${note}`;
  return { level, detail, basis: 'size', context };
}

export function machineView(hardware: HardwareProfile): MachineView {
  return {
    memoryKind: hardware.memoryKind,
    totalMemoryBytes: hardware.totalMemoryBytes,
    gpuMemoryBytes: hardware.gpuMemoryBytes,
    gpuName: hardware.gpuName,
  };
}
