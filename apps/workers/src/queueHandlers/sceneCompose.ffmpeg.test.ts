import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegRunner } from '@bike4mind/server-utils/generationJobs/ffmpegRunner';
import { buildSceneComposeArgs, parseFfmpegProbe, probeArgs } from '@bike4mind/services/sceneJobs';

// The binary the generation-job Lambda ships; FFMPEG_PATH stands in where its postinstall download was skipped.
const binary = process.env.FFMPEG_PATH || ffmpegStatic;
const available = !!binary && existsSync(binary);

/**
 * Runs the real ffmpeg over the exact arguments a Scene render builds, so a flag the pinned build rejects or a
 * filter graph it cannot parse fails here rather than on the first real render.
 */
describe.skipIf(!available)('Scene compose with the real ffmpeg binary', () => {
  const runner = createFfmpegRunner(() => binary ?? '');
  const signal = new AbortController().signal;
  const timeoutMs = 60_000;
  let dir: string;

  const ffmpeg = async (args: string[]) => {
    const { exitCode, stderr } = await runner.run(args, { signal, timeoutMs });
    if (exitCode !== 0) throw new Error(`ffmpeg exited ${exitCode}: ${stderr}`);
  };
  const probe = async (path: string) =>
    parseFfmpegProbe((await runner.run(probeArgs(path), { signal, timeoutMs })).stderr);

  beforeAll(async () => {
    dir = await mkdtemp(`${tmpdir()}/scene-compose-test-`);
    const generate = (lavfi: string[], output: string, codec: string[]) =>
      ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', ...lavfi, ...codec, output]);
    await generate(['-i', 'testsrc=duration=3:size=160x120:rate=10'], `${dir}/video`, ['-c:v', 'mpeg4', '-f', 'mp4']);
    await generate(['-i', 'sine=frequency=440:duration=1'], `${dir}/audio`, ['-c:a', 'aac', '-f', 'mp4']);
    await generate(['-i', 'color=c=blue:size=64x64', '-frames:v', '1'], `${dir}/cover`, [
      '-f',
      'image2',
      '-c:v',
      'png',
    ]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loops a 1s tone under a 3s video, embeds the cover and keeps the video length', async () => {
    const video = await probe(`${dir}/video`);
    const audio = await probe(`${dir}/audio`);
    expect(video).toMatchObject({ hasVideo: true, hasAudio: false });
    expect(audio).toMatchObject({ hasAudio: true });
    expect(await probe(`${dir}/cover`)).toMatchObject({ hasVideo: true });

    const outputPath = `${dir}/scene.mp4`;
    await ffmpeg(
      buildSceneComposeArgs({
        videoPath: `${dir}/video`,
        audioPath: `${dir}/audio`,
        coverPath: `${dir}/cover`,
        outputPath,
        videoSeconds: video.durationSeconds ?? 0,
        audioSeconds: audio.durationSeconds ?? 0,
        audio: { fit: 'loop', fadeInSeconds: 0.5, fadeOutSeconds: 1 },
        title: 'Test "Scene"; $(not a command)',
      })
    );

    const scene = await probe(outputPath);
    expect(scene).toMatchObject({ hasVideo: true, hasAudio: true });
    expect(scene.durationSeconds).toBeGreaterThan(2.8);
    expect(scene.durationSeconds).toBeLessThan(3.2);
  }, 60_000);

  it('trims a track longer than the video to the video length', async () => {
    await ffmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=8',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      `${dir}/long-audio`,
    ]);
    const outputPath = `${dir}/trimmed.mp4`;
    await ffmpeg(
      buildSceneComposeArgs({
        videoPath: `${dir}/video`,
        audioPath: `${dir}/long-audio`,
        outputPath,
        videoSeconds: 3,
        audioSeconds: 8,
        audio: { fit: 'trim', fadeInSeconds: 0, fadeOutSeconds: 1.5 },
      })
    );
    const scene = await probe(outputPath);
    expect(scene.durationSeconds).toBeGreaterThan(2.8);
    expect(scene.durationSeconds).toBeLessThan(3.2);
  }, 60_000);
});
