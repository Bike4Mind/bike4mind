import {
  estimateFit,
  estimateFitFromSize,
  fitMarginBytes,
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
const TIGHT_NOTE = 'Close other apps first, or this computer may slow down.';

type Plan = FitPlan & { fits: boolean };

export function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

/**
 * What a model can use once the planner's headroom is kept free: on the GPU (`usable`), and with layers in system
 * RAM too (`machine`). Need is compared against these, so the shown numbers and the verdict agree.
 */
function limits(budgetBytes: number, ramPoolBytes: number, marginBytes: number) {
  return { usable: budgetBytes - marginBytes, machine: budgetBytes + ramPoolBytes - marginBytes };
}

/** The limit a model too large for this computer is past; GPU memory when offload failed on more than weights. */
function tooLargeLimit(needBytes: number, usable: number, machine: number): string {
  return needBytes > machine
    ? `the ${formatMemory(machine)} this computer can hold for a model`
    : `the ${formatMemory(usable)} of GPU memory a model can use here`;
}

const withTightNote = (fit: { level: FitLevel; detail: string }) =>
  fit.level === 'tight' ? { ...fit, detail: `${fit.detail} ${TIGHT_NOTE}` } : fit;

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
  const { totalBytes, budgetBytes, ramPoolBytes, marginBytes } = plan.memory;
  const { usable, machine } = limits(budgetBytes, ramPoolBytes, marginBytes);
  const need = formatMemory(totalBytes);
  const ctx = `the ${contextLabel(plan.context)} context chat will use`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  if (!plan.fits)
    return {
      level: 'too-large',
      detail: `Needs about ${need} at ${ctx}, more than ${tooLargeLimit(totalBytes, usable, machine)}.${note}`,
    };
  if (plan.placement === 'expert-offload' || plan.placement === 'layer-offload')
    return {
      level: 'tight',
      detail: `Fits at ${ctx} only with part of it in system RAM, so replies are slower: about ${need} in all.`,
    };
  const where = cpuOnly ? 'in memory' : 'in GPU memory';
  const usage = `about ${need} of the ${formatMemory(usable)} a model can use here`;
  if (totalBytes + marginBytes > budgetBytes * TIGHT_SHARE)
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
  return {
    ...withTightNote(describe(planned, memoryBudgets(hardware).cpuOnly)),
    basis: 'arch',
    context: planned.context,
  };
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
  const { usable, machine } = limits(budgetBytes, memoryBudgets(hardware).ramPool, fitMarginBytes(hardware));
  const ctx =
    options.limitKnown === false
      ? `the context chat will use (up to ${contextLabel(context)})`
      : `the ${contextLabel(context)} context chat will use`;
  const rough = `Rough estimate from the file size: about ${formatMemory(needBytes)} before the memory for ${ctx}`;
  const budget = `the ${formatMemory(usable)} a model can use here`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  const detail =
    level === 'too-large'
      ? `${rough}, more than ${tooLargeLimit(needBytes, usable, machine)}.${note}`
      : offloadBytes > 0
        ? `${rough}, more than ${budget}, so part of it runs from system RAM and replies are slower.`
        : level === 'tight'
          ? `${rough}, close to ${budget}.${note}`
          : `${rough}, of ${budget}.${note}`;
  return { ...withTightNote({ level, detail }), basis: 'size', context };
}

export function machineView(hardware: HardwareProfile): MachineView {
  return {
    memoryKind: hardware.memoryKind,
    totalMemoryBytes: hardware.totalMemoryBytes,
    gpuMemoryBytes: hardware.gpuMemoryBytes,
    gpuName: hardware.gpuName,
    confidence: hardware.confidence,
  };
}
