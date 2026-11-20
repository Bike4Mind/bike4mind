import { describe, expect, it, vi } from 'vitest';
import type { IGenerationJobDocument } from '@bike4mind/common';
import { loadSpeechScript } from './speechScript';

const FILE_ID = 'f'.repeat(24);

const speechFile = (generation: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  sourceMetadata: {
    generation: { generator: 'speech', provider: 'elevenlabs', jobId: 'job1', prompt: 'Hi you', ...generation },
  },
});

const speechJob = (payload: Record<string, unknown> = {}) =>
  ({
    id: 'job1',
    kind: 'speech',
    payload: {
      request: { text: 'Hi you, the full script', provider: 'elevenlabs' },
      candidates: ['elevenlabs'],
      saveToFiles: true,
      output: {
        location: 'files',
        s3Key: 'k',
        fileId: FILE_ID,
        contentType: 'audio/mpeg',
        bytes: 1,
        durationSeconds: 1.25,
      },
      wordTimings: [{ text: 'Hi', startMs: 0, endMs: 200 }],
      ...payload,
    },
  }) as unknown as IGenerationJobDocument;

describe('loadSpeechScript', () => {
  it('reads the full script, word timings and duration from the job that made the file', async () => {
    const findJob = vi.fn(async () => speechJob());
    await expect(loadSpeechScript(speechFile(), findJob)).resolves.toEqual({
      text: 'Hi you, the full script',
      truncated: false,
      wordTimings: [{ text: 'Hi', startMs: 0, endMs: 200 }],
      durationMs: 1250,
    });
    expect(findJob).toHaveBeenCalledWith('job1');
  });

  it('falls back to the stored prompt when the job did not produce this file', async () => {
    const otherFile = speechJob({
      output: { location: 'files', s3Key: 'k', fileId: 'e'.repeat(24), contentType: 'x', bytes: 1 },
    });
    await expect(loadSpeechScript(speechFile({ durationSeconds: 2 }), async () => otherFile)).resolves.toEqual({
      text: 'Hi you',
      truncated: false,
      durationMs: 2000,
    });
  });

  it('flags a stored prompt that may be cut short when the job is gone', async () => {
    const script = await loadSpeechScript(speechFile({ promptTruncated: true }), async () => null);
    expect(script).toEqual({ text: 'Hi you', truncated: true });
  });

  it('is null for a file that is not generated speech', async () => {
    const findJob = vi.fn();
    await expect(loadSpeechScript(speechFile({ generator: 'music' }), findJob)).resolves.toBeNull();
    await expect(loadSpeechScript({ id: FILE_ID }, findJob)).resolves.toBeNull();
    expect(findJob).not.toHaveBeenCalled();
  });
});
