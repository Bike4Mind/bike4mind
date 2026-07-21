import { describe, it, expect } from 'vitest';
import { RepeatedCallGuard, DEFAULT_WARN_THRESHOLD, DEFAULT_BLOCK_THRESHOLD } from './repeatedCallGuard';

describe('RepeatedCallGuard.signature', () => {
  it('is stable across argument key order and whitespace', () => {
    const a = RepeatedCallGuard.signature('file_read', '{"path":"a.ts","limit":10}');
    const b = RepeatedCallGuard.signature('file_read', '{ "limit": 10, "path": "a.ts" }');
    expect(a).toBe(b);
  });

  it('distinguishes different tools and different args', () => {
    expect(RepeatedCallGuard.signature('file_read', '{"path":"a.ts"}')).not.toBe(
      RepeatedCallGuard.signature('file_read', '{"path":"b.ts"}')
    );
    expect(RepeatedCallGuard.signature('file_read', '{"path":"a.ts"}')).not.toBe(
      RepeatedCallGuard.signature('grep', '{"path":"a.ts"}')
    );
  });

  it('falls back to the raw string for non-JSON arguments', () => {
    expect(RepeatedCallGuard.signature('t', '  raw  ')).toBe(RepeatedCallGuard.signature('t', 'raw'));
  });

  it('treats undefined and empty arguments as equal', () => {
    expect(RepeatedCallGuard.signature('t', undefined)).toBe(RepeatedCallGuard.signature('t', ''));
  });
});

describe('RepeatedCallGuard escalation', () => {
  it('warns at warnThreshold and blocks at blockThreshold for an unchanged result', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 3, blockThreshold: 5 });
    const sig = RepeatedCallGuard.signature('file_read', '{"path":"a.ts"}');

    // Calls 1-2: no warning, never blocked.
    for (let i = 1; i <= 2; i++) {
      expect(guard.shouldBlock(sig)).toBe(false);
      expect(guard.record(sig, 'same').warn).toBe(false);
    }
    // Calls 3-5: warning, still executes (not yet blocked before execution).
    for (let i = 3; i <= 5; i++) {
      expect(guard.shouldBlock(sig)).toBe(false);
      expect(guard.record(sig, 'same').warn).toBe(true);
    }
    // Count has now reached 5 -> the next attempt is blocked before execution.
    expect(guard.shouldBlock(sig)).toBe(true);
  });

  it('resets the counter when the result changes (progress)', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 2, blockThreshold: 3 });
    const sig = RepeatedCallGuard.signature('run_tests', '{}');

    expect(guard.record(sig, 'fail').count).toBe(1);
    expect(guard.record(sig, 'fail').count).toBe(2);
    // Result changed -> counter resets, never reaching the block threshold.
    expect(guard.record(sig, 'pass').count).toBe(1);
    expect(guard.record(sig, 'pass').count).toBe(2);
    expect(guard.shouldBlock(sig)).toBe(false);
  });

  it('tracks each signature independently (cycling among files)', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 2, blockThreshold: 3 });
    const files = ['a.ts', 'b.ts', 'c.ts'];

    // Cycle through the files repeatedly - each accumulates its own count.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const f of files) {
        const sig = RepeatedCallGuard.signature('file_read', `{"path":"${f}"}`);
        if (!guard.shouldBlock(sig)) guard.record(sig, `contents of ${f}`);
      }
    }
    for (const f of files) {
      expect(guard.shouldBlock(RepeatedCallGuard.signature('file_read', `{"path":"${f}"}`))).toBe(true);
    }
  });

  it('recovers a blocked read after a mutation invalidates read-only history', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 2, blockThreshold: 3 });
    const read = RepeatedCallGuard.signature('file_read', '{"path":"a.ts"}');

    // Read the same file until it blocks.
    guard.record(read, 'old contents', true);
    guard.record(read, 'old contents', true);
    guard.record(read, 'old contents', true);
    expect(guard.shouldBlock(read)).toBe(true);

    // A mutation runs (e.g. the file was edited) -> read history is invalidated.
    const edit = RepeatedCallGuard.signature('edit_file', '{"path":"a.ts"}');
    guard.record(edit, 'edited', false);
    guard.invalidateReadOnly();

    // The follow-up re-read is no longer blocked and sees the new content.
    expect(guard.shouldBlock(read)).toBe(false);
    expect(guard.record(read, 'new contents', true).count).toBe(1);
  });

  it('still catches a write-spin: invalidateReadOnly keeps mutating-call counts', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 2, blockThreshold: 3 });
    const write = RepeatedCallGuard.signature('edit_file', '{"path":"a.ts","content":"x"}');

    // Same write, same result, repeated - each mutation invalidates reads but
    // must not wipe its own counter.
    for (let i = 0; i < 3; i++) {
      guard.record(write, 'written', false);
      guard.invalidateReadOnly();
    }
    expect(guard.shouldBlock(write)).toBe(true);
  });

  it('resets all history on reset()', () => {
    const guard = new RepeatedCallGuard({ warnThreshold: 2, blockThreshold: 2 });
    const sig = RepeatedCallGuard.signature('t', '{}');
    guard.record(sig, 'x');
    guard.record(sig, 'x');
    expect(guard.shouldBlock(sig)).toBe(true);
    guard.reset();
    expect(guard.shouldBlock(sig)).toBe(false);
  });
});

describe('RepeatedCallGuard disabled', () => {
  it('never warns or blocks when disabled', () => {
    const guard = new RepeatedCallGuard({ enabled: false, warnThreshold: 1, blockThreshold: 1 });
    const sig = RepeatedCallGuard.signature('t', '{}');
    for (let i = 0; i < 10; i++) {
      expect(guard.record(sig, 'same').warn).toBe(false);
      expect(guard.shouldBlock(sig)).toBe(false);
    }
  });
});

describe('RepeatedCallGuard defaults', () => {
  it('uses the documented default thresholds', () => {
    const guard = new RepeatedCallGuard();
    expect(guard.blockLimit).toBe(DEFAULT_BLOCK_THRESHOLD);
    const sig = RepeatedCallGuard.signature('t', '{}');
    for (let i = 1; i < DEFAULT_WARN_THRESHOLD; i++) {
      expect(guard.record(sig, 'same').warn).toBe(false);
    }
    expect(guard.record(sig, 'same').warn).toBe(true);
  });
});
