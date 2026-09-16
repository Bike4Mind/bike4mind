import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitEvalReport } from './harness';

describe('emitEvalReport', () => {
  let dir: string;
  const original = process.env.PROMPT_EVAL_REPORT_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.PROMPT_EVAL_REPORT_PATH;
    else process.env.PROMPT_EVAL_REPORT_PATH = original;
  });

  // The defect this guards is silent and expensive: vitest drops console output, so a live eval that
  // printed its report with `console.log` exited 0 having produced nothing, after paying for hundreds
  // of sequential completions. A spy on `console.log` would pass against that broken version.
  it('writes to stdout rather than console, which vitest swallows', () => {
    delete process.env.PROMPT_EVAL_REPORT_PATH;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitEvalReport('PASS one (100%)');

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('PASS one (100%)'));
    expect(log).not.toHaveBeenCalled();
    stdout.mockRestore();
    log.mockRestore();
  });

  it('appends every report to PROMPT_EVAL_REPORT_PATH so a long run outlives the terminal', () => {
    const path = join(dir, 'report.txt');
    process.env.PROMPT_EVAL_REPORT_PATH = path;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    emitEvalReport('shipped arm');
    emitEvalReport('candidate arm');

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('shipped arm');
    expect(written).toContain('candidate arm');
    stdout.mockRestore();
  });

  it('is a no-op on disk when no path is configured', () => {
    delete process.env.PROMPT_EVAL_REPORT_PATH;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(() => emitEvalReport('no path set')).not.toThrow();

    stdout.mockRestore();
  });
});
