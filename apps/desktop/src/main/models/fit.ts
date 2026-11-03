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

/** Whose memory a verdict rates: this computer's, or a saved server's entered specs. */
export type FitWhere = 'local' | 'server';

const WORDS: Record<FitWhere, { holder: string; place: string; tight: string }> = {
  local: { holder: 'this computer', place: 'here', tight: 'Close other apps first, or this computer may slow down.' },
  server: {
    holder: 'that server',
    place: 'on that server',
    tight: 'Close other apps on that server first, or it may slow down.',
  },
};

/** The GPU budget a model can use; a CPU-only machine has no GPU memory to name. */
const usableWords = (usableBytes: number, cpuOnly: boolean, where: FitWhere) =>
  `${formatMemory(usableBytes)}${cpuOnly ? '' : ' of GPU memory'} a model can use ${WORDS[where].place}`;

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

/**
 * A need past its limit and that limit as shown, with more decimals while they would read the same, then rounded
 * apart to whole MiB.
 */
function needAndLimit(needBytes: number, limitBytes: number): [string, string] {
  const shown: [string, string] = [formatMemory(needBytes), formatMemory(limitBytes)];
  for (let digits = 2; digits <= 3 && shown[0] === shown[1]; digits++) {
    const fine = (bytes: number) => `${Number((bytes / 1024 ** 3).toFixed(digits))} GiB`;
    shown.splice(0, 2, fine(needBytes), fine(limitBytes));
  }
  if (shown[0] === shown[1])
    return [`${Math.ceil(needBytes / 1024 ** 2)} MiB`, `${Math.floor(limitBytes / 1024 ** 2)} MiB`];
  return shown;
}

/** A too-large need and the limit it is past; GPU memory when offload failed on more than weights. */
function tooLarge(needBytes: number, usable: number, machine: number, where: FitWhere) {
  const overMachine = needBytes > machine;
  const [need, limit] = needAndLimit(needBytes, overMachine ? machine : usable);
  const past = overMachine
    ? `the ${limit} ${WORDS[where].holder} can hold for a model`
    : `the ${limit} of GPU memory a model can use ${WORDS[where].place}`;
  return { need, past };
}

const withTightNote = (fit: { level: FitLevel; detail: string }, where: FitWhere) =>
  fit.level === 'tight' ? { ...fit, detail: `${fit.detail} ${WORDS[where].tight}` } : fit;

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

function describe(plan: Plan, cpuOnly: boolean, where: FitWhere): { level: FitLevel; detail: string } {
  const { totalBytes, budgetBytes, ramPoolBytes, marginBytes, offloadedBytes, weightsBytes } = plan.memory;
  const { usable, machine } = limits(budgetBytes, ramPoolBytes, marginBytes);
  const need = formatMemory(totalBytes);
  const ctx = `the ${contextLabel(plan.context)} context chat will use`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  if (!plan.fits) {
    const over = tooLarge(totalBytes, usable, machine, where);
    return { level: 'too-large', detail: `Needs about ${over.need} at ${ctx}, more than ${over.past}.${note}` };
  }
  // offloadedBytes past the weights left on the GPU means most of the model's weights are in system RAM.
  if (plan.placement === 'layer-offload' && offloadedBytes > weightsBytes)
    return {
      level: 'tight',
      detail: `Fits at ${ctx} only with most of it in system RAM, so most of it runs on the CPU and replies will be slow: about ${need} in all.`,
    };
  if (plan.placement === 'expert-offload' || plan.placement === 'layer-offload')
    return {
      level: 'tight',
      detail: `Fits at ${ctx} only with part of it in system RAM, so replies are slower: about ${need} in all.`,
    };
  const place = cpuOnly ? 'in memory' : 'in GPU memory';
  const usage = `about ${need} of the ${usableWords(usable, cpuOnly, where)}`;
  if (totalBytes + marginBytes > budgetBytes * TIGHT_SHARE)
    return { level: 'tight', detail: `Only just fits ${place} at ${ctx}: ${usage}.${note}` };
  return { level: 'fits', detail: `Fits ${place} at ${ctx}: ${usage}.${note}` };
}

/** The shared estimator's plan for an Ollama load at `context`, the one chatContextTokens (main/chat/localContext.ts) says chat requests. */
export function fitFromArch(
  arch: ModelArch,
  weightsBytes: number,
  hardware: HardwareProfile,
  context: number,
  options: { mmprojBytes?: number; where?: FitWhere } = {}
): ModelFit {
  const where = options.where ?? 'local';
  const planned = plan(arch, weightsBytes, hardware, context, options.mmprojBytes);
  return {
    ...withTightNote(describe(planned, memoryBudgets(hardware).cpuOnly, where), where),
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
  options: { limitKnown?: boolean; where?: FitWhere } = {}
): ModelFit {
  const where = options.where ?? 'local';
  const { level, needBytes, budgetBytes, offloadBytes, cpuOnly } = estimateFitFromSize(sizeBytes, hardware, context);
  const { usable, machine } = limits(budgetBytes, memoryBudgets(hardware).ramPool, fitMarginBytes(hardware));
  const ctx =
    options.limitKnown === false
      ? `the context chat will use (up to ${contextLabel(context)})`
      : `the ${contextLabel(context)} context chat will use`;
  const rough = (need: string) => `Rough estimate from the file size: about ${need} before the memory for ${ctx}`;
  const about = rough(formatMemory(needBytes));
  const budget = `the ${usableWords(usable, cpuOnly, where)}`;
  const note = cpuOnly ? ` ${CPU_NOTE}` : '';
  let detail: string;
  if (level === 'too-large') {
    const over = tooLarge(needBytes, usable, machine, where);
    // Otherwise it was refused for the context room a size-only estimate keeps free.
    detail =
      needBytes > machine || offloadBytes > sizeBytes
        ? `${rough(over.need)}, more than ${over.past}.${note}`
        : `${about}, too much of the ${formatMemory(machine)} ${WORDS[where].holder} can hold for a model to leave room for that.`;
  } else if (offloadBytes > sizeBytes / 2)
    detail = `${about}, more than ${budget}, so most of it runs on the CPU from system RAM and replies will be slow.`;
  else if (offloadBytes > 0)
    detail = `${about}, more than ${budget}, so part of it runs from system RAM and replies are slower.`;
  else detail = level === 'tight' ? `${about}, close to ${budget}.${note}` : `${about}, of ${budget}.${note}`;
  return { ...withTightNote({ level, detail }, where), basis: 'size', context };
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
