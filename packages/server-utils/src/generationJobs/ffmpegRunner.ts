import { accessSync, chmodSync, constants, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FfmpegRunner } from '@bike4mind/services/sceneJobs';

// Probe output is a few KB and a render runs at -loglevel error; this only bounds a pathological stream summary.
const MAX_STDERR_BYTES = 8 * 1024 * 1024;

let configuredBinary: string | undefined;

/**
 * Registers the ffmpeg binary the generation-job worker ships (apps/workers/src/queueHandlers/generationJob.ts passes
 * the `ffmpeg-static` path). Deliberately a registration rather than an import here: this module is reachable from
 * the Next server, whose file tracer would otherwise pack the ~80 MB binary into a bundle that never renders.
 */
export const configureFfmpegBinary = (binaryPath: string | null | undefined): void => {
  if (binaryPath) configuredBinary = binaryPath;
};

let executableBinary: string | undefined;

/**
 * FFMPEG_PATH (self-host images, local dev) outranks the registered binary. A copy whose execute bit was lost in
 * packaging is copied once to /tmp and made executable there, since the deployment package is read-only.
 */
export const resolveFfmpegBinary = (): string => {
  const binary = process.env.FFMPEG_PATH || configuredBinary;
  if (!binary) throw new Error('ffmpeg is not available on this host (set FFMPEG_PATH)');
  if (executableBinary) return executableBinary;
  try {
    accessSync(binary, constants.X_OK);
    executableBinary = binary;
  } catch {
    const copy = `${tmpdir()}/b4m-ffmpeg`;
    copyFileSync(binary, copy);
    chmodSync(copy, 0o755);
    executableBinary = copy;
  }
  return executableBinary;
};

/**
 * Runs ffmpeg with an argument array (never through a shell). A non-zero exit resolves with its code and stderr;
 * a spawn failure, the timeout (SIGKILL) or an abort of `signal` rejects.
 */
export const createFfmpegRunner = (resolveBinary: () => string = resolveFfmpegBinary): FfmpegRunner => ({
  run: (args, { signal, timeoutMs }) =>
    new Promise((resolve, reject) => {
      let binary: string;
      try {
        binary = resolveBinary();
      } catch (error) {
        reject(error);
        return;
      }
      // Fetched at call time, not imported: Turbopack reads a static execFile(binary, ...) as dynamic filesystem
      // access and traces the whole project into the Next server Lambda (the trace is why the preview blew its size cap).
      const { execFile } = process.getBuiltinModule('node:child_process');
      execFile(
        binary,
        [...args],
        { signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_STDERR_BYTES, windowsHide: true },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stderr });
            return;
          }
          // A numeric code is the process's own exit status; a string code (ENOENT, ...) or a kill is not.
          if (typeof error.code === 'number' && !error.killed) {
            resolve({ exitCode: error.code, stderr });
            return;
          }
          reject(error);
        }
      );
    }),
});
