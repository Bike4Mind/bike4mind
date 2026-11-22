import { describe, expect, it } from 'vitest';
import {
  diffFunctionContracts,
  functionContractChangeSentence,
  type FunctionContract,
  type FunctionContractDiff,
  type FunctionField,
} from './functionContract';

const baseContract = (): FunctionContract => ({
  name: 'beam_check',
  description: 'Checks a beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load'],
    properties: {
      load: { type: 'number', unit: 'N', exclusiveMinimum: 0 },
      span: { type: 'number', unit: 'm', minimum: 1, maximum: 10, default: 5, description: 'Span.' },
      count: { type: 'integer', unit: '1', minimum: 0 },
      mode: { type: 'string', enum: ['fast', 'exact'] },
      label: { type: 'string', maxLength: 100 },
      flag: { type: 'boolean' },
      points: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['x'],
          properties: { x: { type: 'number', unit: 'm' } },
        },
      },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: {
      deflection: { type: 'number', unit: 'm' },
      peak: { type: 'number', unit: 'm', minimum: 0, maximum: 1 },
      grade: { type: 'string', enum: ['A', 'B'] },
      notes: { type: 'string' },
      series: { type: 'array', maxItems: 10, items: { type: 'number', unit: 'm' } },
    },
  },
});

type Side = 'inputs' | 'outputs';
type Mutation = (contract: FunctionContract) => void;

const field = (contract: FunctionContract, side: Side, name: string) =>
  contract[side].properties[name] as FunctionField & Record<string, unknown>;

const diffAfter = (mutate: Mutation): FunctionContractDiff => {
  const next = baseContract();
  mutate(next);
  return diffFunctionContracts(baseContract(), next);
};

const summary = (diff: FunctionContractDiff) => ({
  breaking: diff.breaking.map(({ path, kind }) => `${kind} ${path}`),
  compatible: diff.compatible.map(({ path, kind }) => `${kind} ${path}`),
});

const set =
  (side: Side, name: string, key: string, value: unknown): Mutation =>
  contract => {
    const target = field(contract, side, name);
    if (value === undefined) delete target[key];
    else target[key] = value;
  };

describe('diffFunctionContracts', () => {
  it('finds nothing between equal contracts', () => {
    expect(diffAfter(() => {})).toEqual({ breaking: [], compatible: [] });
  });

  // Breaking kinds the plan names.
  it.each<[string, Mutation, string]>([
    [
      'an input removed',
      c => {
        delete c.inputs.properties.span;
      },
      'removed inputs.span',
    ],
    [
      'an output removed',
      c => {
        delete c.outputs.properties.deflection;
        c.outputs.required = [];
      },
      'removed outputs.deflection',
    ],
    [
      'an input type changed',
      c => {
        c.inputs.properties.label = { type: 'number', unit: '1' };
      },
      'type_changed inputs.label.type',
    ],
    [
      'an output type changed',
      c => {
        c.outputs.properties.notes = { type: 'boolean' };
      },
      'type_changed outputs.notes.type',
    ],
    ['an input unit changed', set('inputs', 'load', 'unit', 'kN'), 'unit_changed inputs.load.unit'],
    ['an output unit changed', set('outputs', 'deflection', 'unit', 'mm'), 'unit_changed outputs.deflection.unit'],
    ['an input enum value removed', set('inputs', 'mode', 'enum', ['fast']), 'enum_value_removed inputs.mode.enum'],
    ['an output enum value removed', set('outputs', 'grade', 'enum', ['A']), 'enum_value_removed outputs.grade.enum'],
    [
      'an input newly required',
      c => {
        c.inputs.required = ['load', 'span'];
      },
      'newly_required inputs.span',
    ],
    ['an input lower bound raised', set('inputs', 'span', 'minimum', 2), 'bounds_narrowed inputs.span.minimum'],
    ['an input upper bound added', set('inputs', 'load', 'maximum', 100), 'bounds_narrowed inputs.load.maximum'],
    [
      'an inclusive input bound made exclusive',
      set('inputs', 'span', 'exclusiveMinimum', 1),
      'bounds_narrowed inputs.span.minimum',
    ],
    ['an input maxLength lowered', set('inputs', 'label', 'maxLength', 50), 'bounds_narrowed inputs.label.maxLength'],
    ['an input minItems raised', set('inputs', 'points', 'minItems', 2), 'bounds_narrowed inputs.points.minItems'],
    ['an input maxItems lowered', set('inputs', 'points', 'maxItems', 5), 'bounds_narrowed inputs.points.maxItems'],
    [
      'an output no longer required',
      c => {
        c.outputs.required = [];
      },
      'no_longer_required outputs.deflection',
    ],
  ])('%s is breaking', (_name, mutate, expected) => {
    expect(summary(diffAfter(mutate))).toEqual({ breaking: [expected], compatible: [] });
  });

  // Compatible kinds the plan names.
  it.each<[string, Mutation, string]>([
    [
      'an optional input added',
      c => {
        c.inputs.properties.depth = { type: 'number', unit: 'm' };
      },
      'added inputs.depth',
    ],
    [
      'an output added',
      c => {
        c.outputs.properties.stress = { type: 'number', unit: 'Pa' };
      },
      'added outputs.stress',
    ],
    [
      'a field description changed',
      set('inputs', 'span', 'description', 'Clear span.'),
      'description_changed inputs.span.description',
    ],
    [
      'a field description added',
      set('outputs', 'deflection', 'description', 'At midspan.'),
      'description_changed outputs.deflection.description',
    ],
    [
      'the description of a side changed',
      c => {
        c.outputs.description = 'Results.';
      },
      'description_changed outputs.description',
    ],
    [
      'the function description changed',
      c => {
        c.description = 'Checks a simply supported beam.';
      },
      'description_changed description',
    ],
    ['an input upper bound raised', set('inputs', 'span', 'maximum', 20), 'bounds_widened inputs.span.maximum'],
    [
      'an input lower bound made inclusive',
      c => {
        c.inputs.properties.load = { type: 'number', unit: 'N', minimum: 0 };
      },
      'bounds_widened inputs.load.minimum',
    ],
    ['an input maxLength raised', set('inputs', 'label', 'maxLength', 200), 'bounds_widened inputs.label.maxLength'],
    [
      'an input enum value added',
      set('inputs', 'mode', 'enum', ['fast', 'exact', 'rough']),
      'enum_value_added inputs.mode.enum',
    ],
  ])('%s is compatible', (_name, mutate, expected) => {
    expect(summary(diffAfter(mutate))).toEqual({ breaking: [], compatible: [expected] });
  });

  it('reads an added exclusiveMinimum looser than the inclusive minimum as no change', () => {
    expect(summary(diffAfter(set('inputs', 'span', 'exclusiveMinimum', 0)))).toEqual({ breaking: [], compatible: [] });
  });

  // Cases the plan does not name, ruled by whether a caller could be refused or receive an unpromised value.
  describe('cases ruled here', () => {
    it.each<[string, Mutation, string]>([
      [
        'an enum value added to an output',
        set('outputs', 'grade', 'enum', ['A', 'B', 'C']),
        'enum_value_added outputs.grade.enum',
      ],
      ['an output lower bound lowered', set('outputs', 'peak', 'minimum', -1), 'bounds_widened outputs.peak.minimum'],
      [
        'an output upper bound removed',
        set('outputs', 'peak', 'maximum', undefined),
        'bounds_widened outputs.peak.maximum',
      ],
      [
        'an output maxItems removed',
        set('outputs', 'series', 'maxItems', undefined),
        'bounds_widened outputs.series.maxItems',
      ],
      ['an enum added to an input', set('inputs', 'label', 'enum', ['a', 'b']), 'enum_added inputs.label.enum'],
      ['an enum removed from an output', set('outputs', 'grade', 'enum', undefined), 'enum_removed outputs.grade.enum'],
      [
        'a required input added',
        c => {
          c.inputs.properties.depth = { type: 'number', unit: 'm' };
          c.inputs.required = ['load', 'depth'];
        },
        'added_required inputs.depth',
      ],
      [
        'a nested input unit changed',
        c => {
          const points = field(c, 'inputs', 'points') as FunctionField & {
            items: { properties: Record<string, FunctionField> };
          };
          points.items.properties.x = { type: 'number', unit: 'mm' };
        },
        'unit_changed inputs.points[].x.unit',
      ],
      [
        'the function renamed',
        c => {
          c.name = 'beam_check_v2';
        },
        'name_changed name',
      ],
    ])('%s is breaking', (_name, mutate, expected) => {
      expect(summary(diffAfter(mutate))).toEqual({ breaking: [expected], compatible: [] });
    });

    it.each<[string, Mutation, string]>([
      ['a default added', set('inputs', 'count', 'default', 3), 'default_changed inputs.count.default'],
      ['a default removed', set('inputs', 'span', 'default', undefined), 'default_changed inputs.span.default'],
      ['a default changed', set('inputs', 'span', 'default', 6), 'default_changed inputs.span.default'],
      ['an input bound removed', set('inputs', 'span', 'minimum', undefined), 'bounds_widened inputs.span.minimum'],
      ['an output lower bound raised', set('outputs', 'peak', 'minimum', 0.5), 'bounds_narrowed outputs.peak.minimum'],
      [
        'a required input made optional',
        c => {
          c.inputs.required = [];
        },
        'no_longer_required inputs.load',
      ],
      [
        'an output newly required',
        c => {
          c.outputs.required = ['deflection', 'peak'];
        },
        'newly_required outputs.peak',
      ],
      ['an enum removed from an input', set('inputs', 'mode', 'enum', undefined), 'enum_removed inputs.mode.enum'],
      ['an enum added to an output', set('outputs', 'notes', 'enum', ['ok']), 'enum_added outputs.notes.enum'],
    ])('%s is compatible', (_name, mutate, expected) => {
      expect(summary(diffAfter(mutate))).toEqual({ breaking: [], compatible: [expected] });
    });

    it('reads a rename as a breaking removal and a compatible addition', () => {
      const diff = diffAfter(c => {
        c.inputs.properties.span_m = c.inputs.properties.span;
        delete c.inputs.properties.span;
      });
      expect(summary(diff)).toEqual({ breaking: ['removed inputs.span'], compatible: ['added inputs.span_m'] });
    });

    it('compares integer bounds by the whole numbers they allow', () => {
      const diff = diffAfter(c => {
        c.inputs.properties.count = { type: 'integer', unit: '1', exclusiveMinimum: -1 };
      });
      expect(summary(diff)).toEqual({ breaking: [], compatible: [] });
    });

    it('stops at a type change instead of also listing the old type keywords', () => {
      const diff = diffAfter(c => {
        c.inputs.properties.span = { type: 'string' };
      });
      expect(summary(diff)).toEqual({ breaking: ['type_changed inputs.span.type'], compatible: [] });
    });
  });

  it('says each change in plain words', () => {
    const removed = diffAfter(c => {
      delete c.outputs.properties.deflection;
      c.outputs.required = [];
    });
    const unit = diffAfter(set('inputs', 'load', 'unit', 'kN'));
    const bound = diffAfter(set('inputs', 'span', 'minimum', 2));
    const output = diffAfter(set('outputs', 'grade', 'enum', ['A', 'B', 'C']));
    expect([removed, unit, bound, output].map(diff => functionContractChangeSentence(diff.breaking[0]))).toEqual([
      'output deflection was removed',
      'input load changed unit from N to kN',
      'input span narrowed from at least 1 to at least 2',
      'output grade can now return C',
    ]);
  });
});
