import { execFile } from 'node:child_process';
import type { LoadedModel } from '@bike4mind/local-models';
import type { GpuMemoryCap } from '@shared/models';

type Exec = (command: string, args: string[]) => Promise<{ stdout: string }>;

const EXEC_TIMEOUT_MS = 5_000;
// Below this share on the GPU, Ollama placed layers on the CPU; above it the gap is rounding or a projector.
const PARTIAL_SHARE = 0.9;
const C2C_ARGS = ['--query-gpu=c2c.mode', '--format=csv,noheader'];

const execNvidiaSmi: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

/**
 * nvidia-smi's c2c.mode per device: `Enabled` on a GPU wired to the CPU's own memory (RTX Spark N1X, GB10). Null when
 * no line is a mode, as from an nvidia-smi that does not know the field.
 */
export function parseC2cMode(stdout: string): boolean | null {
  const modes = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^(Enabled|Disabled|\[?N\/A\]?)$/i.test(line));
  if (modes.length === 0) return null;
  return modes.some(mode => /^Enabled$/i.test(mode));
}

/** Queried apart from the hardware probe, since an nvidia-smi that lacks the field fails the whole query. */
export async function probeIntegratedGpu(exec: Exec = execNvidiaSmi): Promise<boolean | null> {
  try {
    return parseC2cMode((await exec('nvidia-smi', C2C_ARGS)).stdout);
  } catch {
    return null;
  }
}

/** This Linux process runs in WSL. */
export function runsInWsl(env: Record<string, string | undefined>, procVersion: string | null): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(procVersion ?? '');
}

/** A model folder Ollama reported as a Linux path, so it runs under Linux. */
export function isLinuxStoreDir(path: string | null): boolean {
  return typeof path === 'string' && path.startsWith('/');
}

const positiveFinite = (value: number) => Number.isFinite(value) && value > 0;

const onGpu = ({ sizeBytes, vramBytes }: LoadedModel) =>
  positiveFinite(sizeBytes) && Number.isFinite(vramBytes) && vramBytes >= 0 && vramBytes >= sizeBytes * PARTIAL_SHARE;

/** A loaded model within `usableGpuBytes` that Ollama held partly or wholly on the CPU; null when there is none. */
export function partialLoad(loaded: readonly LoadedModel[], usableGpuBytes: number): GpuMemoryCap | null {
  if (!positiveFinite(usableGpuBytes)) return null;
  const found = loaded.find(
    model =>
      positiveFinite(model.sizeBytes) &&
      Number.isFinite(model.vramBytes) &&
      model.vramBytes >= 0 &&
      model.sizeBytes <= usableGpuBytes &&
      !onGpu(model)
  );
  return found ? { model: found.name, sizeBytes: found.sizeBytes, gpuBytes: found.vramBytes } : null;
}

/** A model larger than the GPU part `cap` was held to now runs on the GPU, so the limit no longer applies. */
export function clearsCap(loaded: readonly LoadedModel[], cap: GpuMemoryCap): boolean {
  return loaded.some(model => onGpu(model) && model.sizeBytes > cap.gpuBytes);
}
