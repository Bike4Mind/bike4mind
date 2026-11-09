// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  STRUCTURED_SETTINGS,
  describeFields,
  getAtPath,
  setAtPath,
  validateConfig,
  type FieldSpec,
} from './schemaSettingForm';

const leaves = (fields: FieldSpec[]): FieldSpec[] =>
  fields.flatMap(field => (field.kind === 'group' ? leaves(field.fields) : [field]));

describe('schemaSettingForm', () => {
  it.each(Object.entries(STRUCTURED_SETTINGS))(
    'gives every field of %s a control, a title and help',
    (_, { schema }) => {
      for (const field of leaves(describeFields(schema))) {
        expect(field.kind, field.path.join('.')).not.toBe('unsupported');
        expect(field.label, field.path.join('.')).not.toBe('');
        expect(field.help, `${field.path.join('.')} has no help text`).toBeTruthy();
      }
    }
  );

  it('reads kinds, bounds and nullability from the schema', () => {
    const schema = z.object({
      choice: z.enum(['a', 'b']).nullable().prefault(null),
      count: z.number().int().min(1).max(9).prefault(1),
      atLeastOne: z.number().int().min(1).prefault(1),
      ratio: z.number().positive().prefault(1),
      flag: z.boolean().prefault(false),
      nested: z.object({ inner: z.number().prefault(0) }).prefault({}),
    });
    const [choice, count, atLeastOne, ratio, flag, nested] = describeFields(schema);
    expect(choice).toMatchObject({ kind: 'enum', options: ['a', 'b'], nullable: true, label: 'Choice' });
    expect(count).toMatchObject({ kind: 'number', integer: true, min: 1, max: 9 });
    expect(atLeastOne).toMatchObject({ kind: 'number', integer: true, min: 1, max: undefined });
    expect(ratio).toMatchObject({ kind: 'number', integer: false, exclusiveMin: 0 });
    expect(flag).toMatchObject({ kind: 'boolean' });
    expect(nested).toMatchObject({ kind: 'group', fields: [{ kind: 'number', path: ['nested', 'inner'] }] });
  });

  it('gets and sets nested paths without mutating', () => {
    const value = { a: { b: 1 }, c: 2 };
    const next = setAtPath(value, ['a', 'b'], 5);
    expect(getAtPath(next, ['a', 'b'])).toBe(5);
    expect(value.a.b).toBe(1);
    expect(next.c).toBe(2);
  });

  it('keys validation errors by field path, in range words', () => {
    const { schema } = STRUCTURED_SETTINGS.usagePatternSignalsConfig;
    const fields = describeFields(schema);
    const value = {
      ...schema.parse({}),
      weights: { ...schema.parse({}).weights, quickApiKey: 101 },
      maxUsersPerRun: NaN,
    };
    expect(validateConfig(schema, fields, value)).toEqual({
      'weights.quickApiKey': 'Enter a number from 0 to 100.',
      maxUsersPerRun: 'Enter a whole number from 1 to 10000.',
    });
  });

  it('asks to confirm only the risky containment changes, and only when turning them on', () => {
    const { schema, confirmations } = STRUCTURED_SETTINGS.autoContainmentConfig;
    const stored = schema.parse({});
    expect(confirmations?.({ ...stored, maxPerHour: 1 }, stored)).toEqual([]);
    expect(confirmations?.({ ...stored, mode: 'enforce' }, stored)).toHaveLength(1);
    expect(confirmations?.({ ...stored, mode: 'enforce', blockEmailDomains: true }, stored)).toHaveLength(2);
    const enforcing = { ...stored, mode: 'enforce' };
    expect(confirmations?.(enforcing, enforcing)).toEqual([]);
  });
});
