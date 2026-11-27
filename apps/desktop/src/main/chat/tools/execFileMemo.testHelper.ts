import type { execFile } from 'node:child_process';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
type Outcome = [error: Error | null, stdout: string, stderr: string];

const outcomes = new Map<string, Promise<Outcome>>();
let paused = false;

/**
 * `execFile` that runs each distinct call (program, arguments, folder, environment) once and replays its outcome.
 * The approval suites scan fixed fixtures with the same read-only git and find queries hundreds of times; a test
 * that changes a fixture, or counts the programs started, calls `pauseExecFileMemo` first.
 * Use from `vi.mock('node:child_process', ...)`.
 */
export function memoizedExecFile(actual: typeof execFile): typeof execFile {
  const memoized = (...call: unknown[]) => {
    const [file, args, options, callback] = call;
    if (paused || call.length !== 4 || typeof callback !== 'function') {
      return (actual as (...passed: unknown[]) => unknown)(...call);
    }
    const key = JSON.stringify([file, args, options]);
    let outcome = outcomes.get(key);
    if (outcome === undefined) {
      outcome = new Promise(done => {
        (actual as (...passed: unknown[]) => unknown)(file, args, options, (...result: Outcome) => done(result));
      });
      outcomes.set(key, outcome);
    }
    void outcome.then(result => (callback as Callback)(...result));
    return undefined;
  };
  return memoized as unknown as typeof execFile;
}

/** Runs every execFile for real until `resumeExecFileMemo`, forgetting what was recorded. */
export function pauseExecFileMemo(): void {
  paused = true;
  outcomes.clear();
}

export function resumeExecFileMemo(): void {
  if (paused) outcomes.clear();
  paused = false;
}
