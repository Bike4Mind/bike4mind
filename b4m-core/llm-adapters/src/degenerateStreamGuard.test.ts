import { describe, it, expect } from 'vitest';
import {
  createDegenerateStreamGuard,
  DEGENERATE_STREAM_STOP_REASON,
  type DegenerateStreamVerdict,
} from './degenerateStreamGuard';

/** Feed text in realistic small chunks, returning the first verdict (if any). */
function stream(text: string, chunk = 40, options = {}): DegenerateStreamVerdict | null {
  const guard = createDegenerateStreamGuard(options);
  for (let i = 0; i < text.length; i += chunk) {
    const verdict = guard.push(text.slice(i, i + chunk));
    if (verdict) return verdict;
  }
  return null;
}

/** Plausible prose/code filler with no long-range periodicity. */
function healthyText(chars: number): string {
  const lines: string[] = [];
  let i = 0;
  while (lines.join('\n').length < chars) {
    lines.push(
      `  const value${i} = compute(${i}, ${i * 7 + 3}); // step ${i} of the reduction, tolerance ${(i % 9) / 10}`
    );
    i++;
  }
  return lines.join('\n');
}

describe('createDegenerateStreamGuard', () => {
  it('catches the observed tool-markup loop', () => {
    // The real incident: `</invoke>` and `</parameter>` alternating thousands of times.
    const verdict = stream('</invoke>\n</parameter>\n'.repeat(400));

    expect(verdict).not.toBeNull();
    expect(verdict!.repeats).toBeGreaterThanOrEqual(25);
    expect(verdict!.periodChars).toBeLessThanOrEqual(512);
    expect(verdict!.unit).toContain('invoke');
  });

  it('trips early rather than near the ceiling', () => {
    // 400 reps is ~9KB. Catching it inside a few KB is the whole point: the
    // ceiling that actually stopped the incident was ~500KB of output.
    const verdict = stream('</invoke>\n</parameter>\n'.repeat(400));

    expect(verdict!.totalChars).toBeLessThan(6000);
  });

  it('catches a single repeated line', () => {
    const line = 'I apologize for the confusion.\n';
    const verdict = stream(line.repeat(200));

    expect(verdict).not.toBeNull();
    expect(verdict!.periodChars).toBe(line.length);
    // The unit is measured from an arbitrary cut point in the tail, so it is a
    // ROTATION of the source line rather than the line itself. Assert that
    // rather than a phase we have no reason to guarantee.
    expect(line.repeat(2)).toContain(verdict!.unit);
  });

  it('catches a repeated single character', () => {
    const verdict = stream('-'.repeat(5000));
    expect(verdict).not.toBeNull();
    expect(verdict!.periodChars).toBe(1);
  });

  it('leaves healthy prose and code alone', () => {
    expect(stream(healthyText(60_000))).toBeNull();
  });

  it('leaves a long non-repeating token blob alone', () => {
    // Pseudo-random base64-ish content: no periodicity, high entropy.
    let blob = '';
    let seed = 7;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < 40_000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      blob += alphabet[seed % alphabet.length];
    }
    expect(stream(blob)).toBeNull();
  });

  it('does not trip on a short repetition that then resolves', () => {
    // A handful of repeated lines is normal (boilerplate, a small table) and must
    // not be treated as degeneration.
    const text = healthyText(3000) + '| x | y |\n'.repeat(8) + healthyText(3000);
    expect(stream(text)).toBeNull();
  });

  it('requires both a long run and enough repeats', () => {
    // Unit of 300 chars repeated only 8 times: long run, too few cycles.
    const unit = healthyText(300).slice(0, 300);
    expect(stream(unit.repeat(8))).toBeNull();
  });

  it('respects a raised repeat threshold', () => {
    const text = '</invoke>\n</parameter>\n'.repeat(400);
    expect(stream(text, 40, { minRepeats: 10_000 })).toBeNull();
  });

  it('no-ops entirely when disabled', () => {
    expect(stream('</invoke>\n</parameter>\n'.repeat(400), 40, { enabled: false })).toBeNull();
  });

  it('latches: only the first verdict is returned', () => {
    const guard = createDegenerateStreamGuard();
    let verdicts = 0;
    const text = '</invoke>\n</parameter>\n'.repeat(600);
    for (let i = 0; i < text.length; i += 40) {
      if (guard.push(text.slice(i, i + 40))) verdicts++;
    }
    expect(verdicts).toBe(1);
  });

  it('tracks total chars seen', () => {
    const guard = createDegenerateStreamGuard();
    guard.push('abc');
    guard.push('de');
    expect(guard.totalChars()).toBe(5);
  });

  it('ignores empty pushes', () => {
    const guard = createDegenerateStreamGuard();
    expect(guard.push('')).toBeNull();
    expect(guard.totalChars()).toBe(0);
  });

  it('detects repetition that begins after a healthy prefix', () => {
    const verdict = stream(healthyText(20_000) + '</invoke>\n</parameter>\n'.repeat(400));
    expect(verdict).not.toBeNull();
    expect(verdict!.unit).toContain('invoke');
  });

  it('exposes a stop reason outside the clean-finish vocabulary', () => {
    // Must not be one of CLEAN_FINISH_REASONS in apps/client replyTruncation.ts,
    // or the reply would render as a normal completion.
    expect(['end_turn', 'stop', 'tool_use', 'stop_sequence']).not.toContain(DEGENERATE_STREAM_STOP_REASON);
  });
});
