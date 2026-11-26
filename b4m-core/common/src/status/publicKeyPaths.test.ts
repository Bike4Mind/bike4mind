import { describe, expect, it } from 'vitest';
import { PUBLIC_SNAPSHOT_KEY_PATHS, collectPublicSnapshotKeyPaths, collectSchemaKeyPaths } from './publicKeyPaths';
import { PublicSummarySchema } from './schemas.public';
import { z } from 'zod';

describe('PUBLIC_SNAPSHOT_KEY_PATHS', () => {
  it('equals every key path of the strict public schemas', () => {
    expect([...PUBLIC_SNAPSHOT_KEY_PATHS]).toEqual(collectPublicSnapshotKeyPaths());
  });

  it('is sorted and has no duplicates', () => {
    const list = [...PUBLIC_SNAPSHOT_KEY_PATHS];
    expect(list).toEqual([...list].sort());
    expect(new Set(list).size).toBe(list.length);
  });

  it('lists probesTrigger beside probesAsOf', () => {
    expect(PUBLIC_SNAPSHOT_KEY_PATHS).toContain('summary.probesAsOf');
    expect(PUBLIC_SNAPSHOT_KEY_PATHS).toContain('summary.probesTrigger');
  });

  it('names no internal identifier', () => {
    const joined = PUBLIC_SNAPSHOT_KEY_PATHS.join('\n');
    for (const forbidden of [
      'componentKey',
      'contributorId',
      'authorId',
      'internalNotes',
      'classification',
      'source',
      'detection',
      'editHistory',
      'probeKeys',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('walks objects, arrays, tuples and wrappers', () => {
    const schema = z.strictObject({
      a: z.string().nullable(),
      b: z.array(z.strictObject({ c: z.number().optional() })),
      t: z.tuple([z.string(), z.number()]),
      u: z.union([z.strictObject({ x: z.string() }), z.strictObject({ y: z.string() })]),
    });
    expect(collectSchemaKeyPaths(schema, 'f')).toEqual([
      'f.a',
      'f.b',
      'f.b[].c',
      'f.t',
      'f.t[0]',
      'f.t[1]',
      'f.u',
      'f.u.x',
      'f.u.y',
    ]);
  });

  it('detects a field added to a schema', () => {
    const before = collectSchemaKeyPaths(PublicSummarySchema, 'summary');
    const after = collectSchemaKeyPaths(PublicSummarySchema.extend({ extra: z.string() }), 'summary');
    expect(after).toEqual([...before, 'summary.extra'].sort());
  });

  it.each([
    ['record', () => z.record(z.string(), z.string())],
    ['pipe', () => z.string().transform(value => value.length)],
    ['lazy', () => z.lazy(() => z.strictObject({ hidden: z.string() }))],
    ['catch', () => z.strictObject({ a: z.string() }).catch({ a: '' })],
    ['any', () => z.any()],
    ['unknown', () => z.unknown()],
  ])('throws on a %s schema instead of hiding the keys inside it', (_name, build) => {
    expect(() => collectSchemaKeyPaths(z.strictObject({ wrapped: build() }), 'f')).toThrow(/cannot walk/);
  });

  it('still walks refined objects, enums, literals and dates', () => {
    const schema = z
      .strictObject({ a: z.enum(['x', 'y']), b: z.literal(1), c: z.date(), d: z.boolean(), e: z.number().int() })
      .refine(() => true);
    expect(collectSchemaKeyPaths(schema, 'f')).toEqual(['f.a', 'f.b', 'f.c', 'f.d', 'f.e']);
  });
});
