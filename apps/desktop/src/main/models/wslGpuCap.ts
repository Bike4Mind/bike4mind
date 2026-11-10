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

/** Desktop runs on Windows or inside WSL, so Ollama at this computer's address may run in WSL. */
export function isWslHost(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  procVersion: () => string | null
): boolean {
  return platform === 'win32' || (platform === 'linux' && runsInWsl(env, procVersion()));
}

// Releases whose scheduler holds an integrated GPU to free system RAM, the VM's under WSL (server/sched.go
// availableMemoryForGPU): added in v0.30.0-rc0, checked through v0.40.15. Newer ones may carry the upstream fix.
const FIRST_CAPPED_RELEASE = [0, 30, 0];
const LAST_CAPPED_RELEASE = [0, 40, 15];
// A build reports its tag, 0.0.0 or a `git describe` version such as 0.40.13-11-g3f9c2d1. A patched build can report a
// plain release number, so a version in range is flagged only once the running binary is read (ollamaWslPatch.ts).
const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\d+)?$/;

const compareParts = (a: readonly number[], b: readonly number[]) => {
  const differs = a.findIndex((part, index) => part !== b[index]);
  return differs === -1 ? 0 : a[differs] - b[differs];
};

/**
 * An /api/version in the releases known to hold an integrated GPU under WSL to the VM's memory. A newer release may
 * include the fix, so it does not count, nor does a source build or a missing version.
 */
export function releaseCapsWslGpu(version: string | null): boolean {
  const match = version === null ? null : RELEASE_VERSION.exec(version.trim());
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  return compareParts(parts, FIRST_CAPPED_RELEASE) >= 0 && compareParts(parts, LAST_CAPPED_RELEASE) <= 0;
}

const CAP_EFFECT =
  "limits GPU memory to the WSL virtual machine's memory, so if this model needs more than that, it runs partly on the CPU and replies slowly. Giving WSL more memory in .wslconfig raises the limit.";

/** The fit badge's flag, naming the release that has the limit, or, without one, the load that showed it. */
export function wslGpuCapWarning(release: string | null): string {
  return release ? `Ollama ${release.trim()} in WSL ${CAP_EFFECT}` : `It looks like Ollama in WSL ${CAP_EFFECT}`;
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

/** A model at least as large as the one `cap` was seen on now runs on the GPU, so the limit no longer applies. */
export function clearsCap(loaded: readonly LoadedModel[], cap: GpuMemoryCap): boolean {
  return loaded.some(model => onGpu(model) && model.sizeBytes >= cap.sizeBytes);
}
