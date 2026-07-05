import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the update utilities so we can drive each branch of the orchestration
// without touching the network, npm, or the real config file.
vi.mock('../utils/updateChecker.js', () => ({
  INSTALL_CMD: 'npm install -g @bike4mind/cli@latest',
  REEXEC_GUARD_ENV: 'B4M_UPDATED_REEXEC',
  checkForUpdate: vi.fn(),
  forceCheckForUpdate: vi.fn(),
  isNpmPrefixWritable: vi.fn(),
  getAutoUpdatePreference: vi.fn(),
  setAutoUpdatePreference: vi.fn(),
  shouldAttemptAutoUpdate: vi.fn(),
}));

vi.mock('../utils/ripgrepCheck.js', () => ({
  checkRipgrep: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// Mock readline so the 'ask'-preference prompt resolves to a scripted answer
// instead of blocking on real stdin. This drives the real promptUpdateChoice.
vi.mock('readline', () => ({
  createInterface: vi.fn(),
}));

import { execSync, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import {
  checkForUpdate,
  isNpmPrefixWritable,
  getAutoUpdatePreference,
  setAutoUpdatePreference,
  shouldAttemptAutoUpdate,
} from '../utils/updateChecker.js';
import { maybeAutoUpdateOnLaunch } from './updateCommand.js';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedCheck = vi.mocked(checkForUpdate);
const mockedWritable = vi.mocked(isNpmPrefixWritable);
const mockedPref = vi.mocked(getAutoUpdatePreference);
const mockedSetPref = vi.mocked(setAutoUpdatePreference);
const mockedGate = vi.mocked(shouldAttemptAutoUpdate);
const mockedCreateInterface = vi.mocked(createInterface);

/** Make the next readline prompt resolve to `answer` (simulating a keypress). */
function answerPromptWith(answer: string): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  mockedCreateInterface.mockReturnValue({
    on: vi.fn(), // 'close' handler registered but never fired for a normal answer
    question: (_q: string, cb: (a: string) => void) => cb(answer),
    close,
  } as unknown as ReturnType<typeof createInterface>);
  return { close };
}

/** Simulate EOF / Ctrl-D: the 'close' event fires and question never resolves. */
function answerPromptWithEof(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  mockedCreateInterface.mockReturnValue({
    on: (event: string, cb: () => void) => {
      if (event === 'close') cb();
    },
    question: vi.fn(), // callback never fires on EOF
    close,
  } as unknown as ReturnType<typeof createInterface>);
  return { close };
}

/** Override process.stdin.isTTY for a test; returns a restore fn. */
function stubStdinTTY(value: boolean | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original);
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  };
}

const updateReady = { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true };

describe('maybeAutoUpdateOnLaunch', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockImplementation set in one test
    // - e.g. the install-fails case throwing from execSync - can't leak into the
    // tests that run after it.
    vi.resetAllMocks();
    // Default happy-path: gates open, preference 'auto' (silent), update
    // available, prefix writable. 'auto' keeps these tests on the no-prompt
    // branch so they exercise install + re-exec directly.
    mockedGate.mockReturnValue(true);
    mockedPref.mockResolvedValue('auto');
    mockedSetPref.mockResolvedValue(undefined);
    mockedWritable.mockResolvedValue(true);
    mockedCheck.mockResolvedValue(updateReady);
    // spawnSync returns a successful child by default.
    mockedSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    // process.exit must not actually kill the test runner - throw a sentinel.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs and re-execs with the loop-guard env when an update is available on a writable prefix', async () => {
    await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__0');

    expect(mockedExecSync).toHaveBeenCalledWith(
      'npm install -g @bike4mind/cli@latest',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    // Re-exec must target THIS node + argv (the mechanism that picks up the new
    // code), not some other path - a wrong target would still "spawn once".
    expect(mockedSpawnSync.mock.calls[0][0]).toBe(process.argv[0]);
    expect(mockedSpawnSync.mock.calls[0][1]).toEqual(process.argv.slice(1));
    const spawnEnv = mockedSpawnSync.mock.calls[0][2]?.env as NodeJS.ProcessEnv;
    expect(spawnEnv.B4M_UPDATED_REEXEC).toBe('1');
    // The 'auto' preference installs silently - it must never open the prompt.
    expect(mockedCreateInterface).not.toHaveBeenCalled();
  });

  it('does NOT install when the prefix is not writable (falls through to the notify banner)', async () => {
    mockedWritable.mockResolvedValue(false);

    await maybeAutoUpdateOnLaunch();

    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('does NOT re-exec when the install fails', async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('npm install failed');
    });

    await maybeAutoUpdateOnLaunch();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('no-ops when no update is available', async () => {
    mockedCheck.mockResolvedValue({ ...updateReady, latestVersion: '1.0.0', updateAvailable: false });

    await maybeAutoUpdateOnLaunch();

    expect(mockedWritable).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('no-ops (before any network call) when the env/TTY/re-exec gate blocks it', async () => {
    mockedGate.mockReturnValue(false);

    await maybeAutoUpdateOnLaunch();

    expect(mockedCheck).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("no-ops (before any network call) when the preference is 'never'", async () => {
    mockedPref.mockResolvedValue('never');

    await maybeAutoUpdateOnLaunch();

    expect(mockedCheck).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  describe("'ask' preference — on-launch prompt", () => {
    let restoreStdin: () => void;

    beforeEach(() => {
      mockedPref.mockResolvedValue('ask');
      // promptUpdateChoice bails on a non-interactive stdin; make it interactive
      // so these tests reach the readline prompt. (vitest's stdin is not a TTY.)
      restoreStdin = stubStdinTTY(true);
    });

    afterEach(() => {
      restoreStdin();
    });

    it("'Update once' (U) installs + re-execs without persisting a preference", async () => {
      answerPromptWith('u');

      await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__0');

      expect(mockedSetPref).not.toHaveBeenCalled();
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    });

    it("empty input defaults to 'Update once' (installs + re-execs)", async () => {
      answerPromptWith('');

      await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__0');

      expect(mockedSetPref).not.toHaveBeenCalled();
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
    });

    it("'Always' (A) persists autoUpdate=true, then installs + re-execs", async () => {
      answerPromptWith('A');

      await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__0');

      expect(mockedSetPref).toHaveBeenCalledWith(true);
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    });

    it("'Skip' (S) does not install and persists nothing", async () => {
      answerPromptWith('s');

      await maybeAutoUpdateOnLaunch();

      expect(mockedSetPref).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it("'Never' (N) persists autoUpdate=false and does not install", async () => {
      answerPromptWith('n');

      await maybeAutoUpdateOnLaunch();

      expect(mockedSetPref).toHaveBeenCalledWith(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('normalizes whitespace + uppercase input (" N " => never, no install)', async () => {
      answerPromptWith(' N ');

      await maybeAutoUpdateOnLaunch();

      expect(mockedSetPref).toHaveBeenCalledWith(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
    });

    it('treats uppercase "S" as skip (no install, no persist)', async () => {
      answerPromptWith('S');

      await maybeAutoUpdateOnLaunch();

      expect(mockedSetPref).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
    });

    it('EOF / Ctrl-D at the prompt skips silently — never installs, never hangs', async () => {
      answerPromptWithEof();

      await maybeAutoUpdateOnLaunch();

      expect(mockedSetPref).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('does not prompt (and does not install) when stdin is not a TTY', async () => {
      restoreStdin(); // undo the interactive stub for this case
      restoreStdin = stubStdinTTY(false);
      answerPromptWith('u'); // would install IF the prompt were reached

      await maybeAutoUpdateOnLaunch();

      expect(mockedCreateInterface).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });

    it('closes the readline interface after prompting (calls rl.close)', async () => {
      const { close } = answerPromptWith('s');

      await maybeAutoUpdateOnLaunch();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not prompt when no update is available', async () => {
      mockedCheck.mockResolvedValue({ ...updateReady, latestVersion: '1.0.0', updateAvailable: false });

      await maybeAutoUpdateOnLaunch();

      expect(mockedCreateInterface).not.toHaveBeenCalled();
    });

    it('does not prompt when the prefix is not writable', async () => {
      mockedWritable.mockResolvedValue(false);

      await maybeAutoUpdateOnLaunch();

      expect(mockedCreateInterface).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
    });
  });

  it('no-ops when the update check throws', async () => {
    mockedCheck.mockRejectedValue(new Error('network down'));

    await maybeAutoUpdateOnLaunch();

    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('no-ops when the check times out (race resolves null)', async () => {
    // Simulates the 3s race timing out before checkForUpdate resolves.
    mockedCheck.mockResolvedValue(null);

    await maybeAutoUpdateOnLaunch();

    expect(mockedWritable).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('propagates a non-zero exit status from the re-execed child', async () => {
    mockedSpawnSync.mockReturnValue({ status: 3 } as ReturnType<typeof spawnSync>);

    await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__3');
  });

  it('exits 1 (not 0) when the re-exec fails to launch', async () => {
    mockedSpawnSync.mockReturnValue({
      status: null,
      error: new Error('spawn ENOENT'),
    } as unknown as ReturnType<typeof spawnSync>);

    await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__1');
  });

  it('maps a signal-killed child to a non-zero exit', async () => {
    mockedSpawnSync.mockReturnValue({
      status: null,
      signal: 'SIGKILL',
    } as unknown as ReturnType<typeof spawnSync>);

    await expect(maybeAutoUpdateOnLaunch()).rejects.toThrow('__exit__1');
  });
});
