import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { detectOllamaInstall } from '@bike4mind/local-models';

// Settings only an Ollama built with the WSL shared GPU memory change declares, the current patch's and an earlier
// one's. No release has either: the sources of v0.30.0 through v0.40.16-rc0 contain neither name.
export const WSL_MEMORY_PATCH_MARKERS = ['OLLAMA_WSL_SHARED_GPU_MEMORY', 'OLLAMA_WSL_GPU_SPILL'] as const;

const PROBE_TIMEOUT_MS = 10_000;
const CHUNK_BYTES = 1 << 20;

/** Whether the file at `path` contains any of `markers`; null when it is not read to the end by `deadline` (epoch ms). */
export async function fileContainsAny(
  path: string,
  markers: readonly string[],
  deadline: number,
  chunkBytes = CHUNK_BYTES
): Promise<boolean | null> {
  const needles = markers.map(marker => Buffer.from(marker, 'latin1'));
  const overlap = Math.max(0, ...needles.map(needle => needle.length - 1));
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(chunkBytes + overlap);
    let carried = 0;
    for (;;) {
      if (Date.now() > deadline) return null;
      const { bytesRead } = await handle.read(buffer, carried, chunkBytes, null);
      const filled = carried + bytesRead;
      const window = buffer.subarray(0, filled);
      if (needles.some(needle => window.includes(needle))) return true;
      if (bytesRead === 0) return false;
      // A marker may straddle two reads, so the tail of this one leads the next.
      carried = Math.min(overlap, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `task`'s value, or null when it rejects or is still running at `deadline` (epoch ms). */
async function beforeDeadline<T>(task: Promise<T>, deadline: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([task.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaWslPatchProbeOptions {
  /** The pid of the `ollama serve` behind `url` on this computer; null when none is seen. */
  serverPid?: (url: string) => Promise<number | null>;
  /** Where `/proc` is read; tests point it at a fixture folder. */
  procDir?: string;
  timeoutMs?: number;
}

/**
 * Whether the Ollama serving `url` carries the WSL shared GPU memory change, read from the image its process runs.
 * Null when that cannot be read in full, as for another user's server or one outside this Linux. Linux only.
 */
export function createOllamaWslPatchProbe(
  options: OllamaWslPatchProbeOptions = {}
): (url: string) => Promise<boolean | null> {
  const serverPid =
    options.serverPid ?? (async (url: string) => (await detectOllamaInstall({ url })).process?.pid ?? null);
  const procDir = options.procDir ?? '/proc';
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  // The last image read, so a listing does not scan it again until Ollama restarts on another one.
  let last: { image: string; patched: boolean } | null = null;
  return async url => {
    const deadline = Date.now() + timeoutMs;
    const pid = await beforeDeadline(serverPid(url), deadline);
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return null;
    const exe = join(procDir, String(pid), 'exe');
    const found = await beforeDeadline(stat(exe), deadline);
    if (!found) return null;
    const image = `${pid}:${found.dev}:${found.ino}:${found.size}:${found.mtimeMs}`;
    if (last?.image === image) return last.patched;
    const patched = await fileContainsAny(exe, WSL_MEMORY_PATCH_MARKERS, deadline);
    if (patched !== null) last = { image, patched };
    return patched;
  };
}
