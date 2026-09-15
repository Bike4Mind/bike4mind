import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineTimer } from './PipelineTimer';

describe('PipelineTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks a single phase', () => {
    const timer = new PipelineTimer();
    timer.phase('init');
    vi.advanceTimersByTime(100);
    timer.end();

    const record = timer.toRecord();
    expect(record).toHaveProperty('init', 100);
  });

  it('tracks multiple phases sequentially', () => {
    const timer = new PipelineTimer();
    timer.phase('init');
    vi.advanceTimersByTime(50);
    timer.phase('data');
    vi.advanceTimersByTime(200);
    timer.phase('llm');
    vi.advanceTimersByTime(500);
    timer.end();

    const record = timer.toRecord();
    expect(record.init).toBe(50);
    expect(record.data).toBe(200);
    expect(record.llm).toBe(500);
  });

  it('auto-closes the previous phase when a new phase starts', () => {
    const timer = new PipelineTimer();
    timer.phase('a');
    vi.advanceTimersByTime(10);
    timer.phase('b');
    vi.advanceTimersByTime(20);
    timer.end();

    const record = timer.toRecord();
    expect(record.a).toBe(10);
    expect(record.b).toBe(20);
  });

  it('returns empty record when no phases are recorded', () => {
    const timer = new PipelineTimer();
    expect(timer.toRecord()).toEqual({});
  });

  it('totalMs reflects wall-clock time since creation', () => {
    const timer = new PipelineTimer();
    vi.advanceTimersByTime(300);
    expect(timer.totalMs()).toBe(300);
  });

  it('end() is a no-op when no phase is active', () => {
    const timer = new PipelineTimer();
    timer.end(); // should not throw
    expect(timer.toRecord()).toEqual({});
  });

  it('end() is idempotent', () => {
    const timer = new PipelineTimer();
    timer.phase('init');
    vi.advanceTimersByTime(50);
    timer.end();
    vi.advanceTimersByTime(100);
    timer.end(); // second end should not change the phase duration

    const record = timer.toRecord();
    expect(record.init).toBe(50);
  });

  it('summary() returns a single-line formatted string with all phases', () => {
    const timer = new PipelineTimer();
    timer.phase('init');
    vi.advanceTimersByTime(100);
    timer.phase('llm_completion');
    vi.advanceTimersByTime(900);
    timer.end();

    const summary = timer.summary();
    expect(summary).toContain('init: 100ms');
    expect(summary).toContain('llm_completion: 900ms');
    expect(summary).toContain('TOTAL: 1000ms');
    expect(summary).not.toContain('\n');
  });

  it('summary() shows percentage of total', () => {
    const timer = new PipelineTimer();
    timer.phase('fast');
    vi.advanceTimersByTime(100);
    timer.phase('slow');
    vi.advanceTimersByTime(900);
    timer.end();

    const summary = timer.summary();
    expect(summary).toContain('(10.0%)');
    expect(summary).toContain('(90.0%)');
  });
});
