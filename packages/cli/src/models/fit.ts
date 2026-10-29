/**
 * Fit verdicts for `b4m models` and the MCP model tools: the shared size-only estimate (estimateFitFromSize in
 * @bike4mind/common) against this machine's hardware probe.
 */

import {
  estimateFitFromSize,
  fitMarginBytes,
  ollamaNumCtx,
  type HardwareProfile,
  type SizeFitLevel,
} from '@bike4mind/common';
import { probeHardware, type HubGgufBuild, type HubModelDetail } from '@bike4mind/local-models';
import { formatBytes, largestProjectorBytes, type PullPlan } from './localModels.js';

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
  if (hardware.memoryKind === 'unified')
    return `${hardware.chip ?? 'unified memory'}, ${formatBytes(hardware.totalMemoryBytes)}`;
  if (hardware.memoryKind === 'discrete' && hardware.gpuMemoryBytes) {
    return `${hardware.gpuName ?? 'GPU'} with ${formatBytes(hardware.gpuMemoryBytes)}, ${ram}`;
  }
  return hardware.memoryKind === 'discrete' ? `GPU of unknown memory, rated on the CPU, ${ram}` : `no GPU, ${ram}`;
}

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

function rateOnHardware(sizeBytes: number, hardware: HardwareProfile, trainedContext: number | null): ModelFit {
  const known = trainedContext !== null && trainedContext > 0;
  const context = ollamaNumCtx(known ? trainedContext : Infinity);
  const fit = estimateFitFromSize(sizeBytes, hardware, context);
  const need = `about ${formatBytes(fit.needBytes)} before context memory, at ${known ? '' : 'up to '}the ${contextLabel(context)} context the CLI requests`;
  const budget = `the ${formatBytes(fit.budgetBytes)} a model can use ${fit.cpuOnly ? 'in RAM' : 'in GPU memory'} here`;
  const rough = 'Rough estimate from the file size';
  const reserved = `with ${formatBytes(fitMarginBytes(hardware))} reserved headroom`;
  if (fit.level === 'too-large')
    return { verdict: fit.level, detail: `${rough}: ${need}; ${reserved}, this exceeds ${budget}.` };
  if (fit.level === 'tight') {
    return {
      verdict: fit.level,
      detail:
        fit.offloadBytes > 0
          ? `${rough}: ${need}; ${reserved}, this exceeds ${budget}, so part of it runs from system RAM and replies are slower.`
          : `${rough}: ${need}, close to ${budget}.`,
    };
  }
  return { verdict: fit.level, detail: `${rough}: ${need}, of ${budget}.` };
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
  const reading = await read(plan.target.runtime.baseUrl);
  if (plan.kind === 'ollama') return rateDownload(plan.manifest.sizeBytes, reading, null);
  return fitForHubBuild(plan.build, plan.detail, reading);
}
