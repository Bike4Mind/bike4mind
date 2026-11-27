import { accessSync, constants } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

/** A stand-in "ffmpeg": echoes its arguments to stderr and exits with the code given as the first one. */
const fakeBinary = async (mode: number) => {
  const path = `${dir}/ffmpeg`;
  await writeFile(path, '#!/bin/sh\necho "args:$*" >&2\nexit "$1"\n');
  await chmod(path, mode);
  return path;
};

const loadRunner = async () => {
  vi.resetModules();
  return import('./ffmpegRunner');
};

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/ffmpeg-runner-test-`);
  vi.stubEnv('FFMPEG_PATH', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const run = (
  runner: { run: (args: string[], options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown> },
  args: string[],
  signal = new AbortController().signal
) => runner.run(args, { signal, timeoutMs: 10_000 });

describe('createFfmpegRunner', () => {
  it('passes the arguments as an array, never through a shell', async () => {
    const binary = await fakeBinary(0o755);
    const { createFfmpegRunner } = await loadRunner();
    const result = await run(
      createFfmpegRunner(() => binary),
      ['0', 'title=a; echo pwned', '$(id)']
    );
    expect(result).toEqual({ exitCode: 0, stderr: 'args:0 title=a; echo pwned $(id)\n' });
  });

  it('resolves a non-zero exit with its code and stderr', async () => {
    const binary = await fakeBinary(0o755);
    const { createFfmpegRunner } = await loadRunner();
    expect(
      await run(
        createFfmpegRunner(() => binary),
        ['3']
      )
    ).toEqual({ exitCode: 3, stderr: 'args:3\n' });
  });

  it('rejects when the binary cannot be spawned', async () => {
    const { createFfmpegRunner } = await loadRunner();
    await expect(
      run(
        createFfmpegRunner(() => `${dir}/missing`),
        ['0']
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects when the signal is aborted', async () => {
    const binary = await fakeBinary(0o755);
    const { createFfmpegRunner } = await loadRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(
        createFfmpegRunner(() => binary),
        ['0'],
        controller.signal
      )
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('resolveFfmpegBinary', () => {
  it('fails loudly when no binary is configured', async () => {
    const { resolveFfmpegBinary } = await loadRunner();
    expect(() => resolveFfmpegBinary()).toThrow(/FFMPEG_PATH/);
  });

  it('prefers FFMPEG_PATH over the registered binary', async () => {
    const binary = await fakeBinary(0o755);
    vi.stubEnv('FFMPEG_PATH', binary);
    const { configureFfmpegBinary, resolveFfmpegBinary } = await loadRunner();
    configureFfmpegBinary(`${dir}/registered`);
    expect(resolveFfmpegBinary()).toBe(binary);
  });

  it('copies a binary that lost its execute bit to an executable path', async () => {
    const binary = await fakeBinary(0o644);
    const { configureFfmpegBinary, resolveFfmpegBinary } = await loadRunner();
    configureFfmpegBinary(binary);
    const resolved = resolveFfmpegBinary();
    expect(resolved).not.toBe(binary);
    expect(() => accessSync(resolved, constants.X_OK)).not.toThrow();
  });
});
