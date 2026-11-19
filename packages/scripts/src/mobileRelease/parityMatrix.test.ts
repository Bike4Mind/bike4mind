import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareTrains,
  isCellGreen,
  parseParityMatrix,
  parseTrain,
  trainBlockers,
  type ParityFeature,
  type ParityMatrix,
} from './parityMatrix';

const feature = (overrides: Partial<ParityFeature> = {}): ParityFeature => ({
  id: 'feature',
  title: 'Feature',
  web: 'green',
  ios: 'green',
  android: 'green',
  ...overrides,
});

const matrixOf = (...features: ParityFeature[]): ParityMatrix => ({ features });

describe('parseTrain', () => {
  it('parses YY.M', () => {
    expect(parseTrain('26.11')).toEqual({ year: 26, month: 11 });
    expect(parseTrain('1.1')).toEqual({ year: 1, month: 1 });
  });

  it.each(['26', '26.0', '26.13', '26.011', '026.11', '26.11.0', 'x.y'])('rejects %s', value => {
    expect(parseTrain(value)).toBeUndefined();
  });
});

describe('compareTrains', () => {
  it('orders by year then month', () => {
    expect(compareTrains('26.11', '26.12')).toBe(-1);
    expect(compareTrains('26.12', '26.12')).toBe(0);
    expect(compareTrains('27.1', '26.12')).toBe(1);
    expect(compareTrains('26.9', '26.10')).toBe(-1);
  });

  it('names whichever argument is not a train', () => {
    expect(() => compareTrains('bad', '26.11')).toThrow('Not a train id: bad');
    expect(() => compareTrains('26.11', 'worse')).toThrow('Not a train id: worse');
  });
});

describe('parseParityMatrix', () => {
  it('accepts a well-formed matrix', () => {
    const raw = { $comment: 'x', features: [feature({ train: '26.12', notes: 'n' })] };
    expect(parseParityMatrix(raw)).toEqual({ matrix: raw });
  });

  it('reports schema problems with their path', () => {
    const result = parseParityMatrix({
      features: [{ ...feature({ id: 'Bad_Id', train: '26.13' }), ios: 'blue', extra: true }],
    });
    expect('errors' in result && result.errors).toEqual([
      expect.stringMatching(/^features\.0\.id: id must be kebab-case/),
      expect.stringMatching(/^features\.0\.train: train must be YY\.M/),
      expect.stringMatching(/^features\.0\.ios: /),
      expect.stringMatching(/^features\.0: .*extra/),
    ]);
  });

  it('labels a root-level problem', () => {
    const result = parseParityMatrix([]);
    expect('errors' in result && result.errors).toEqual([expect.stringMatching(/^\(root\): /)]);
  });

  it('rejects a duplicate id', () => {
    expect(parseParityMatrix({ features: [feature(), feature()] })).toEqual({
      errors: ['duplicate feature id "feature"'],
    });
  });

  it('accepts the committed matrix', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('./parityMatrix.json', import.meta.url), 'utf8'));
    expect(parseParityMatrix(raw)).toHaveProperty('matrix');
  });
});

describe('isCellGreen', () => {
  it('counts green and na as green', () => {
    expect(isCellGreen(feature({ ios: 'green' }), 'ios')).toBe(true);
    expect(isCellGreen(feature({ ios: 'na' }), 'ios')).toBe(true);
    expect(isCellGreen(feature({ ios: 'yellow' }), 'ios')).toBe(false);
    expect(isCellGreen(feature({ ios: 'red' }), 'ios')).toBe(false);
  });
});

describe('trainBlockers', () => {
  const matrix = matrixOf(
    feature({ id: 'untargeted', android: 'red' }),
    feature({ id: 'earlier-slipped', train: '26.11', android: 'yellow' }),
    feature({ id: 'this-train', train: '26.12', android: 'red', ios: 'green' }),
    feature({ id: 'this-train-done', train: '26.12' }),
    feature({ id: 'later', train: '27.1', android: 'red', ios: 'red' }),
    feature({ id: 'web-only-red', train: '26.12', web: 'red' })
  );

  it('blocks on features due by the train that are not green on the platform', () => {
    expect(trainBlockers(matrix, 'android', '26.12').map(f => f.id)).toEqual(['earlier-slipped', 'this-train']);
  });

  it('judges each platform on its own cell', () => {
    expect(trainBlockers(matrix, 'ios', '26.12')).toEqual([]);
  });

  it('ignores features due in a later train until that train', () => {
    expect(trainBlockers(matrix, 'ios', '27.1').map(f => f.id)).toEqual(['later']);
  });
});
