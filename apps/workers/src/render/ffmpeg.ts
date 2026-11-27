import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { FfmpegRun } from './runRender';

// Enough of stderr to diagnose a failed encode in the logs; ffmpeg runs at -loglevel error, so this is the errors.
const STDERR_TAIL_BYTES = 4096;

/**
 * Reads one `-progress` line. out_time_us is microseconds; out_time_ms is too, despite its name (an old ffmpeg
 * quirk kept for compatibility). Null for every other key and for the N/A ffmpeg prints before the first frame.
 */
export const parseProgressLine = (line: string): number | null => {
  const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  return match ? Number(match[1]) / 1000 : null;
};

type SpawnResult = { stdoutLines: string[]; code: number | null; stderrTail: string };

const runProcess = (
  command: string,
  args: string[],
  signal: AbortSignal,
  onStdoutLine?: (line: string) => void
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutLines: string[] = [];
    let stderrTail = '';
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout }).on('line', line => {
      if (onStdoutLine) onStdoutLine(line);
      else stdoutLines.push(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.once('error', error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', code => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      resolve({ stdoutLines, code, stderrTail });
    });
  });

export const runFfmpeg = async ({ args, signal, onProgress }: FfmpegRun): Promise<void> => {
  const result = await runProcess('ffmpeg', args, signal, line => {
    const outTimeMs = parseProgressLine(line);
    if (outTimeMs !== null) onProgress(outTimeMs);
  });
  if (result.code !== 0) throw new Error(`ffmpeg exited with ${result.code}: ${result.stderrTail.trim()}`);
};

/** True when the file has at least one audio stream. */
export const probeHasAudio = async (localPath: string, signal: AbortSignal): Promise<boolean> => {
  const result = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      // Sources are always downloaded local files; a crafted playlist must not reach the network.
      '-protocol_whitelist',
      'file',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      localPath,
    ],
    signal
  );
  if (result.code !== 0) throw new Error(`ffprobe exited with ${result.code}: ${result.stderrTail.trim()}`);
  return result.stdoutLines.some(line => line.trim().length > 0);
};

/** Parses `ffmpeg -version`'s first line ("ffmpeg version 7.1.1-1", "ffmpeg version n6.0"); null if unrecognised. */
export const parseFfmpegMajorVersion = (versionOutput: string): number | null => {
  const match = /^ffmpeg version n?(\d+)\./m.exec(versionOutput);
  return match ? Number(match[1]) : null;
};

export const detectFfmpegMajorVersion = async (signal: AbortSignal): Promise<number> => {
  const result = await runProcess('ffmpeg', ['-hide_banner', '-version'], signal);
  const major = result.code === 0 ? parseFfmpegMajorVersion(result.stdoutLines.join('\n')) : null;
  if (major === null) throw new Error(`could not read the ffmpeg version: ${result.stderrTail.trim()}`);
  return major;
};
