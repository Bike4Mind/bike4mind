import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DRIVES,
  DEFAULT_HALF_LIVES_MS,
  DRIVE_KEYS,
  DriveVectorSchema,
  applyDriveDelta,
  decayDrives,
  summarizeDrives,
  type DriveKey,
  type DriveVector,
} from './drives';

const UNIFORM_HALF_LIVES: Record<DriveKey, number> = {
  curiosity: 1000,
  progress: 1000,
  social: 1000,
  novelty: 1000,
  caution: 1000,
  aesthetic: 1000,
};

describe('DriveVectorSchema', () => {
  it('accepts a vector with every drive in [0, 1]', () => {
    expect(DriveVectorSchema.safeParse(DEFAULT_DRIVES).success).toBe(true);
  });

  it('rejects a drive below 0', () => {
    expect(DriveVectorSchema.safeParse({ ...DEFAULT_DRIVES, curiosity: -0.01 }).success).toBe(false);
  });

  it('rejects a drive above 1', () => {
    expect(DriveVectorSchema.safeParse({ ...DEFAULT_DRIVES, progress: 1.01 }).success).toBe(false);
  });

  it('rejects a vector missing a drive', () => {
    const { aesthetic, ...partial } = DEFAULT_DRIVES;
    expect(DriveVectorSchema.safeParse(partial).success).toBe(false);
  });
});

describe('DRIVE_KEYS / DEFAULT_DRIVES', () => {
  it('enumerates exactly the six drives', () => {
    expect([...DRIVE_KEYS].sort()).toEqual(
      ['aesthetic', 'caution', 'curiosity', 'novelty', 'progress', 'social'].sort()
    );
  });

  it('DEFAULT_DRIVES is neutral (0.5) for every drive', () => {
    for (const key of DRIVE_KEYS) {
      expect(DEFAULT_DRIVES[key]).toBe(0.5);
    }
  });

  it('defines a half-life for every drive key', () => {
    for (const key of DRIVE_KEYS) {
      expect(DEFAULT_HALF_LIVES_MS[key]).toBeGreaterThan(0);
    }
  });
});

describe('decayDrives', () => {
  it('leaves drives unchanged when no time has elapsed', () => {
    expect(decayDrives(DEFAULT_DRIVES, 0)).toEqual(DEFAULT_DRIVES);
  });

  it('halves each drive after exactly one half-life', () => {
    const decayed = decayDrives(DEFAULT_DRIVES, 1000, UNIFORM_HALF_LIVES);
    for (const key of DRIVE_KEYS) {
      expect(decayed[key]).toBeCloseTo(0.25, 10); // 0.5 * 0.5^1
    }
  });

  it('quarters each drive after two half-lives', () => {
    const decayed = decayDrives(DEFAULT_DRIVES, 2000, UNIFORM_HALF_LIVES);
    for (const key of DRIVE_KEYS) {
      expect(decayed[key]).toBeCloseTo(0.125, 10); // 0.5 * 0.5^2
    }
  });

  it('treats negative elapsed time as zero (no time-travel decay)', () => {
    expect(decayDrives(DEFAULT_DRIVES, -5000, UNIFORM_HALF_LIVES)).toEqual(DEFAULT_DRIVES);
  });

  it('is pure — does not mutate its input', () => {
    const input: DriveVector = { ...DEFAULT_DRIVES };
    decayDrives(input, 1000, UNIFORM_HALF_LIVES);
    expect(input).toEqual(DEFAULT_DRIVES);
  });

  it('keeps every decayed drive within [0, 1]', () => {
    const decayed = decayDrives(DEFAULT_DRIVES, 12345, UNIFORM_HALF_LIVES);
    for (const key of DRIVE_KEYS) {
      expect(decayed[key]).toBeGreaterThanOrEqual(0);
      expect(decayed[key]).toBeLessThanOrEqual(1);
    }
  });
});

describe('applyDriveDelta', () => {
  it('adds a positive delta to the named drive', () => {
    const next = applyDriveDelta(DEFAULT_DRIVES, { curiosity: 0.3 });
    expect(next.curiosity).toBeCloseTo(0.8, 10);
  });

  it('clamps the result at the 1.0 ceiling', () => {
    const next = applyDriveDelta(DEFAULT_DRIVES, { progress: 5 });
    expect(next.progress).toBe(1);
  });

  it('clamps the result at the 0.0 floor', () => {
    const next = applyDriveDelta(DEFAULT_DRIVES, { caution: -5 });
    expect(next.caution).toBe(0);
  });

  it('leaves unspecified drives unchanged', () => {
    const next = applyDriveDelta(DEFAULT_DRIVES, { curiosity: 0.1 });
    expect(next.progress).toBe(DEFAULT_DRIVES.progress);
    expect(next.social).toBe(DEFAULT_DRIVES.social);
  });

  it('ignores non-finite deltas', () => {
    const next = applyDriveDelta(DEFAULT_DRIVES, {
      curiosity: NaN,
      progress: Infinity,
    });
    expect(next.curiosity).toBe(DEFAULT_DRIVES.curiosity);
    expect(next.progress).toBe(DEFAULT_DRIVES.progress);
  });

  it('is pure — does not mutate its input', () => {
    const input: DriveVector = { ...DEFAULT_DRIVES };
    applyDriveDelta(input, { curiosity: 0.2 });
    expect(input).toEqual(DEFAULT_DRIVES);
  });
});

describe('summarizeDrives', () => {
  it('is deterministic for a given vector', () => {
    expect(summarizeDrives(DEFAULT_DRIVES)).toBe(summarizeDrives(DEFAULT_DRIVES));
  });

  it('names all six drives in the summary', () => {
    const summary = summarizeDrives(DEFAULT_DRIVES);
    expect(summary).toContain('curious');
    expect(summary).toContain('motivated by progress');
    expect(summary).toContain('social');
    expect(summary).toContain('drawn to novelty');
    expect(summary).toContain('cautious');
    expect(summary).toContain('aesthetic');
  });

  it('maps neutral 0.5 to the "moderately" band', () => {
    expect(summarizeDrives(DEFAULT_DRIVES)).toContain('moderately curious');
  });

  it('maps band boundaries to the documented intensity words', () => {
    const at = (value: number): string =>
      summarizeDrives({
        curiosity: value,
        progress: value,
        social: value,
        novelty: value,
        caution: value,
        aesthetic: value,
      });
    expect(at(0.0)).toContain('barely curious');
    expect(at(0.2)).toContain('slightly curious');
    expect(at(0.5)).toContain('moderately curious');
    expect(at(0.75)).toContain('strongly curious');
    expect(at(1.0)).toContain('intensely curious');
  });
});
