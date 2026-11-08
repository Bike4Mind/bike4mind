/**
 * Fit verdicts for `b4m models` and the MCP model tools: the shared size-only estimate (estimateFitFromSize in
 * @bike4mind/common) against this machine's hardware probe.
 */

import {
  estimateFitFromSize,
  ollamaNumCtx,
  vramNeedsLlamaServer,
  type HardwareProfile,
  type SizeFitLevel,
} from '@bike4mind/common';
import { probeHardware, type HubGgufBuild, type HubModelDetail } from '@bike4mind/local-models';
import { formatBytes, largestProjectorBytes, type PullPlan } from './localModels.js';

/** What makes an Intel card's memory readable on Linux, for hardware where vramNeedsLlamaServer holds. */
export const LLAMA_SERVER_VRAM_HELP =
  'Linux does not report it; put a llama.cpp SYCL or Vulkan build of llama-server first on PATH, with its ggml-sycl or ggml-vulkan library beside it, and b4m reads it from there.';
export const OLLAMA_SKIPS_INTEL_IGPU =
  'Ollama does not use Intel integrated graphics, so picks and badges assume the CPU.';

export type FitVerdict = SizeFitLevel | 'unknown';

export interface ModelFit {
  verdict: FitVerdict;
  detail: string;
  /** The probe could not read the GPU, so the verdict counts system RAM only. */
  gpuUnread?: true;
}

export const FIT_LABELS: Record<FitVerdict, string> = {
  fits: 'fits',
  tight: 'tight',
  'too-large': 'too large',
  unknown: 'unknown',
};

export type MachineReading = { hardware: HardwareProfile } | { unknown: string };

/** Reads the machine an Ollama at `runtimeBaseUrl` runs on; null means a runtime detected on this machine. */
export type MachineReader = (runtimeBaseUrl: string | null) => Promise<MachineReading>;

export function isLoopbackUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
  );
}

/** Probes this machine once per reader; a remote runtime or a failed probe reads as unknown. */
export function machineReader(probe: () => Promise<HardwareProfile> = () => probeHardware()): MachineReader {
  let probed: Promise<HardwareProfile | null> | undefined;
  return async baseUrl => {
    if (baseUrl && !isLoopbackUrl(baseUrl)) {
      return { unknown: `Ollama at ${baseUrl} runs on another machine, whose memory this one cannot read` };
    }
    probed ??= probe().catch(() => null);
    const hardware = await probed;
    return hardware?.totalMemoryBytes ? { hardware } : { unknown: "This machine's memory could not be read" };
  };
}

export function machineLabel({ hardware }: { hardware: HardwareProfile }): string {
  const ram = `${formatBytes(hardware.totalMemoryBytes)} RAM`;
  if (hardware.memoryKind === 'unified') {
    const label = `${hardware.chip ?? hardware.gpuName ?? 'unified memory'}, ${formatBytes(hardware.totalMemoryBytes)}`;
    return hardware.gpuVendor === 'intel' ? `${label}, rated on the CPU` : label;
  }
  if (hardware.memoryKind === 'discrete' && hardware.gpuMemoryBytes) {
    return `${hardware.gpuName ?? 'GPU'} with ${formatBytes(hardware.gpuMemoryBytes)}, ${ram}`;
  }
  if (vramNeedsLlamaServer(hardware))
    return `Intel GPU of unknown memory (a SYCL or Vulkan llama-server on PATH reads it), rated on the CPU, ${ram}`;
  return hardware.memoryKind === 'discrete' ? `GPU of unknown memory, rated on the CPU, ${ram}` : `no GPU, ${ram}`;
}

const TIGHT_NOTE = 'Close other apps first, or this computer may slow down.';

const contextLabel = (tokens: number) => (tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens));

/**
 * Rates a download of `sizeBytes` at the num_ctx the CLI's Ollama backend requests for it: the trained length
 * capped by ollamaNumCtx, or the cap itself when the length is unknown.
 */
export function rateDownload(sizeBytes: number, reading: MachineReading, trainedContext: number | null): ModelFit {
  if ('unknown' in reading) return { verdict: 'unknown', detail: `${reading.unknown}.` };
  if (!(sizeBytes > 0)) return { verdict: 'unknown', detail: 'The download size is unknown.' };
  const rated = rateOnHardware(sizeBytes, reading.hardware, trainedContext);
  return reading.hardware.confidence === 'low' ? { ...rated, gpuUnread: true } : rated;
}

/**
 * A need past its limit and that limit as shown, with more decimals while they would read the same, then rounded
 * apart to whole MB.
 */
function needAndLimit(needBytes: number, limitBytes: number): [string, string] {
  const shown: [string, string] = [formatBytes(needBytes), formatBytes(limitBytes)];
  for (let digits = 2; digits <= 3 && shown[0] === shown[1]; digits++) {
    const fine = (bytes: number) => `${(bytes / 1e9).toFixed(digits)} GB`;
    shown.splice(0, 2, fine(needBytes), fine(limitBytes));
  }
  if (shown[0] === shown[1]) return [`${Math.ceil(needBytes / 1e6)} MB`, `${Math.floor(limitBytes / 1e6)} MB`];
  return shown;
}

// Worded as Desktop's fitFromSize (apps/desktop/src/main/models/fit.ts); keep the two in step.
function rateOnHardware(sizeBytes: number, hardware: HardwareProfile, trainedContext: number | null): ModelFit {
  const known = trainedContext !== null && trainedContext > 0;
  const context = ollamaNumCtx(known ? trainedContext : Infinity);
  const fit = estimateFitFromSize(sizeBytes, hardware, context);
  // What a model can use once the planner's headroom is kept free, on the GPU and with layers in system RAM too.
  const usable = fit.budgetBytes - fit.marginBytes;
  const machine = fit.budgetBytes + fit.ramPoolBytes - fit.marginBytes;
  const at = `before context memory, at ${known ? '' : 'up to '}the ${contextLabel(context)} context the CLI requests`;
  const need = (shown: string) => `about ${shown} ${at}`;
  const budget = `the ${formatBytes(usable)} a model can use ${fit.cpuOnly ? 'in RAM' : 'in GPU memory'} here`;
  const rough = 'Rough estimate from the file size';
  if (fit.level === 'too-large') {
    const overMachine = fit.needBytes > machine;
    if (!overMachine && fit.offloadBytes <= sizeBytes)
      return {
        verdict: fit.level,
        detail: `${rough}: ${need(formatBytes(fit.needBytes))}, too much of the ${formatBytes(machine)} this computer can hold for a model to leave room for that.`,
      };
    const [shown, limit] = needAndLimit(fit.needBytes, overMachine ? machine : usable);
    const past = overMachine
      ? `the ${limit} this computer can hold for a model`
      : `the ${limit} of GPU memory a model can use here`;
    return { verdict: fit.level, detail: `${rough}: ${need(shown)}, more than ${past}.` };
  }
  const about = `${rough}: ${need(formatBytes(fit.needBytes))}`;
  if (fit.level === 'tight') {
    const why =
      fit.offloadBytes > sizeBytes / 2
        ? `more than ${budget}, so most of it runs on the CPU from system RAM and replies will be slow`
        : fit.offloadBytes > 0
          ? `more than ${budget}, so part of it runs from system RAM and replies are slower`
          : `close to ${budget}`;
    return { verdict: fit.level, detail: `${about}, ${why}. ${TIGHT_NOTE}` };
  }
  return { verdict: fit.level, detail: `${about}, of ${budget}.` };
}

export function fitForHubBuild(build: HubGgufBuild, detail: HubModelDetail, reading: MachineReading): ModelFit {
  // A known projector or shard must not disguise missing weight or projector sizes.
  const sizesKnown =
    build.sizeBytes > 0 &&
    build.files.every(file => file.sizeBytes > 0) &&
    detail.projectors.every(projector => projector.sizeBytes > 0);
  const sizeBytes = sizesKnown ? build.sizeBytes + largestProjectorBytes(detail) : 0;
  return rateDownload(sizeBytes, reading, detail.gguf?.contextLength ?? null);
}

/** The verdict for what a pull plan downloads, projector included. */
export async function fitForPlan(plan: PullPlan, read: MachineReader): Promise<ModelFit> {
  // A saved server on a loopback address is often a tunnel to another machine, so its address says nothing about whose memory it uses.
  const reading: MachineReading = plan.target.server
    ? { unknown: "A saved model server's memory cannot be read from this machine" }
    : await read(plan.target.runtime.baseUrl);
  if (plan.kind === 'ollama') return rateDownload(plan.manifest.sizeBytes, reading, null);
  return fitForHubBuild(plan.build, plan.detail, reading);
}
