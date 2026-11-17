import { describe, expect, it, vi } from 'vitest';
import { findOwnGenerationJob } from './findOwnGenerationJob';
import { resolveImageJobFiles } from './resolveImageJobFiles';

vi.mock('./findOwnGenerationJob', () => ({ findOwnGenerationJob: vi.fn() }));

describe('resolveImageJobFiles', () => {
  it('returns the output file of each own succeeded job and skips the rest', async () => {
    const jobs: Record<string, unknown> = {
      done: { id: 'done', state: 'succeeded', payload: { output: { fileId: 'file-1' } } },
      running: { id: 'running', state: 'running', payload: {} },
      stored: { id: 'stored', state: 'succeeded', payload: { output: { location: 'generated' } } },
    };
    vi.mocked(findOwnGenerationJob).mockImplementation(async id => (jobs[id] ?? null) as never);

    const files = await resolveImageJobFiles({ jobIds: ['done', 'running', 'stored', 'other'], userId: 'u1' });

    expect(files).toEqual([{ jobId: 'done', fileId: 'file-1' }]);
    expect(findOwnGenerationJob).toHaveBeenCalledWith('other', 'u1', 'image');
  });
});
