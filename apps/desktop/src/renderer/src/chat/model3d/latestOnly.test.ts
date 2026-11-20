import { describe, expect, it } from 'vitest';
import { latestOnly } from './latestOnly';

function gatedJob() {
  const runs: Array<() => void> = [];
  const job = () => new Promise<void>(resolve => runs.push(resolve));
  return { job, runs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('latestOnly', () => {
  it('runs at once when idle', () => {
    const { job, runs } = gatedJob();
    latestOnly(job)();
    expect(runs).toHaveLength(1);
  });

  it('collapses every call made during a run into one follow-up run', async () => {
    const { job, runs } = gatedJob();
    const trigger = latestOnly(job);
    trigger();
    for (let index = 0; index < 30; index += 1) trigger();
    expect(runs).toHaveLength(1);
    runs[0]();
    await settle();
    expect(runs).toHaveLength(2);
    runs[1]();
    await settle();
    expect(runs).toHaveLength(2);
  });
});
