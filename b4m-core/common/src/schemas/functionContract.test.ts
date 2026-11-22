import { describe, expect, it } from 'vitest';
import {
  FUNCTION_CONTRACT_LIMITS,
  parseFunctionContract,
  validateFunctionValue,
  type FunctionContractProblem,
  type FunctionObjectField,
} from './functionContract';

const sampleContract = () => ({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span', 'elastic_modulus', 'second_moment'],
    properties: {
      load: { type: 'number', unit: 'N/m', exclusiveMinimum: 0 },
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0 },
      elastic_modulus: { type: 'number', unit: 'Pa', exclusiveMinimum: 0 },
      second_moment: { type: 'number', unit: 'm^4', exclusiveMinimum: 0 },
    } as Record<string, Record<string, unknown>>,
  } as Record<string, unknown>,
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  } as Record<string, unknown>,
  tests: [
    {
      name: 'steel beam, 4 m span',
      input: { load: 1000, span: 4, elastic_modulus: 200e9, second_moment: 8e-6 },
      expected: { deflection: 0.00208333 },
      tolerance: { rel: 1e-5 },
    },
  ] as unknown[],
});

const problemsOf = (raw: unknown): FunctionContractProblem[] => {
  const result = parseFunctionContract(raw);
  return result.ok ? [] : result.problems;
};

const paths = (raw: unknown) => problemsOf(raw).map(problem => problem.path);

const inputProperties = (contract: ReturnType<typeof sampleContract>) =>
  contract.inputs.properties as Record<string, Record<string, unknown>>;

describe('parseFunctionContract', () => {
  it('accepts the sample contract', () => {
    const result = parseFunctionContract(sampleContract());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.name).toBe('beam_midspan_deflection');
    expect(Object.keys(result.contract.inputs.properties)).toEqual([
      'load',
      'span',
      'elastic_modulus',
      'second_moment',
    ]);
    expect(result.contract.tests).toHaveLength(1);
  });

  it('defaults tests to an empty list', () => {
    const contract: Record<string, unknown> = sampleContract();
    delete contract.tests;
    const result = parseFunctionContract(contract);
    expect(result.ok && result.contract.tests).toEqual([]);
  });

  it('refuses a value that is not a dict', () => {
    expect(problemsOf([1, 2])).toEqual([{ path: '', message: 'FUNCTION must be a dict' }]);
    expect(problemsOf(null)).toHaveLength(1);
  });

  it('names the path of a number field without a unit', () => {
    const contract = sampleContract();
    delete inputProperties(contract).span.unit;
    const problems = problemsOf(contract);
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('inputs.properties.span.unit');
    expect(problems[0].message).toMatch(/needs a unit/);
  });

  it('requires a unit on numbers inside list items and nested objects', () => {
    const contract = sampleContract();
    inputProperties(contract).samples = { type: 'array', items: { type: 'integer' } };
    inputProperties(contract).point = {
      type: 'object',
      additionalProperties: false,
      properties: { x: { type: 'number' } },
    };
    expect(paths(contract)).toEqual([
      'inputs.properties.samples.items.unit',
      'inputs.properties.point.properties.x.unit',
    ]);
  });

  it('refuses a unit with a disallowed character', () => {
    const contract = sampleContract();
    inputProperties(contract).span.unit = 'm<script>';
    expect(paths(contract)).toEqual(['inputs.properties.span.unit']);
  });

  it('accepts the dimensionless unit', () => {
    const contract = sampleContract();
    inputProperties(contract).span.unit = '1';
    expect(problemsOf(contract)).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['true', true],
  ])('refuses additionalProperties when %s', (_label, value) => {
    const contract = sampleContract();
    if (value === undefined) delete contract.outputs.additionalProperties;
    else contract.outputs.additionalProperties = value;
    expect(problemsOf(contract)).toEqual([{ path: 'outputs.additionalProperties', message: 'must be false' }]);
  });

  it.each(['$ref', 'oneOf', 'pattern', 'format'])('refuses the %s keyword by name', keyword => {
    const contract = sampleContract();
    inputProperties(contract).span[keyword] = keyword === 'oneOf' ? [] : 'x';
    const problems = problemsOf(contract);
    expect(problems).toEqual([{ path: `inputs.properties.span.${keyword}`, message: `"${keyword}" is not supported` }]);
  });

  it('refuses an unknown key at the top level', () => {
    const contract: Record<string, unknown> = { ...sampleContract(), version: 2 };
    expect(paths(contract)).toEqual(['version']);
  });

  it('refuses a property name that is not an identifier', () => {
    const contract = sampleContract();
    inputProperties(contract)['span-length'] = { type: 'number', unit: 'm' };
    expect(paths(contract)).toEqual(['inputs.properties.span-length']);
  });

  it('refuses a required entry that names an undeclared property', () => {
    const contract = sampleContract();
    contract.inputs.required = ['load', 'height'];
    const problems = problemsOf(contract);
    expect(problems).toEqual([{ path: 'inputs.required.1', message: 'names "height", which is not a field' }]);
  });

  it('refuses nesting deeper than the depth limit', () => {
    const nest = (levels: number): Record<string, unknown> =>
      levels === 0
        ? { type: 'number', unit: 'm' }
        : { type: 'object', additionalProperties: false, properties: { inner: nest(levels - 1) } };
    const atLimit = sampleContract();
    // inputs is level 1, so a number at level 4 is the deepest field allowed.
    inputProperties(atLimit).deep = nest(2);
    expect(problemsOf(atLimit)).toEqual([]);

    const tooDeep = sampleContract();
    inputProperties(tooDeep).deep = nest(3);
    const problems = problemsOf(tooDeep);
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('inputs.properties.deep.properties.inner.properties.inner.properties.inner');
    expect(problems[0].message).toMatch(/more than 4 levels/);
  });

  it('refuses more than 40 properties on one object', () => {
    const contract = sampleContract();
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < FUNCTION_CONTRACT_LIMITS.maxProperties + 1; i++) properties[`p${i}`] = { type: 'boolean' };
    contract.inputs.properties = properties as Record<string, Record<string, unknown>>;
    contract.inputs.required = [];
    contract.tests = [];
    expect(problemsOf(contract)).toEqual([
      { path: 'inputs.properties', message: 'has 41 fields; at most 40 are allowed' },
    ]);
  });

  it('refuses more than 50 test cases', () => {
    const contract = sampleContract();
    contract.tests = Array.from({ length: FUNCTION_CONTRACT_LIMITS.maxTests + 1 }, () => contract.tests[0]);
    expect(problemsOf(contract)).toEqual([{ path: 'tests', message: 'has 51 test cases; at most 50 are allowed' }]);
  });

  it('refuses a test case whose input does not match the inputs schema', () => {
    const contract = sampleContract();
    contract.tests = [
      { name: 'bad', input: { load: 1000, span: -4, elastic_modulus: 1, second_moment: 1 }, expected: {} },
    ];
    expect(problemsOf(contract)).toEqual([{ path: 'tests.0.input.span', message: 'must be greater than 0' }]);
  });

  it('refuses a contract over 32 KB', () => {
    const contract = sampleContract();
    contract.description = 'x';
    inputProperties(contract).span.description = 'y'.repeat(FUNCTION_CONTRACT_LIMITS.maxContractBytes);
    const problems = problemsOf(contract);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/at most 32768 are allowed/);
  });

  it('refuses bounds that are out of order or not finite', () => {
    const contract = sampleContract();
    Object.assign(inputProperties(contract).span, { minimum: 10, maximum: 1 });
    Object.assign(inputProperties(contract).load, { maximum: '5' });
    expect(paths(contract).sort()).toEqual(['inputs.properties.load.maximum', 'inputs.properties.span.minimum']);
  });

  it('refuses a default that does not match its field', () => {
    const contract = sampleContract();
    inputProperties(contract).span.default = -1;
    expect(problemsOf(contract)).toEqual([
      { path: 'inputs.properties.span.default', message: 'must be greater than 0' },
    ]);
  });

  it('returns every problem together', () => {
    const contract = sampleContract();
    contract.name = 'Bad Name';
    delete inputProperties(contract).span.unit;
    inputProperties(contract).load.pattern = '.*';
    delete contract.outputs.additionalProperties;
    expect(paths(contract).sort()).toEqual([
      'inputs.properties.load.pattern',
      'inputs.properties.span.unit',
      'name',
      'outputs.additionalProperties',
    ]);
  });
});

describe('validateFunctionValue', () => {
  const schema: FunctionObjectField = {
    type: 'object',
    additionalProperties: false,
    required: ['span'],
    properties: {
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0, maximum: 100 },
      count: { type: 'integer', unit: '1', minimum: 1, exclusiveMaximum: 10 },
      material: { type: 'string', enum: ['steel', 'timber'] },
      label: { type: 'string', maxLength: 5 },
      note: { type: 'string' },
      pinned: { type: 'boolean' },
      loads: { type: 'array', items: { type: 'number', unit: 'N', minimum: 0 }, minItems: 1, maxItems: 3 },
      point: {
        type: 'object',
        additionalProperties: false,
        required: ['x'],
        properties: { x: { type: 'number', unit: 'm' } },
      },
    },
  };

  const check = (value: unknown) => validateFunctionValue(schema, value);

  it('accepts a valid value', () => {
    expect(
      check({
        span: 4,
        count: 3,
        material: 'steel',
        label: 'abc',
        pinned: true,
        loads: [1, 2],
        point: { x: 0.5 },
      })
    ).toEqual([]);
  });

  it('refuses a value that is not an object', () => {
    expect(check([4])).toEqual([{ path: '', message: 'must be an object' }]);
  });

  it('names a missing required property', () => {
    expect(check({})).toEqual([{ path: 'span', message: 'is required' }]);
  });

  it('names an extra property', () => {
    expect(check({ span: 1, height: 2 })).toEqual([{ path: 'height', message: 'is not part of the contract' }]);
  });

  it('refuses a string for a number', () => {
    expect(check({ span: '4' })).toEqual([{ path: 'span', message: 'must be a number' }]);
  });

  it.each([NaN, Infinity, -Infinity])('refuses %s', value => {
    expect(check({ span: value })).toEqual([{ path: 'span', message: 'must be a finite number' }]);
  });

  it('refuses a fraction for an integer', () => {
    expect(check({ span: 1, count: 2.5 })).toEqual([{ path: 'count', message: 'must be a whole number' }]);
  });

  it.each([
    [{ span: 0 }, 'span', 'must be greater than 0'],
    [{ span: 101 }, 'span', 'must be at most 100'],
    [{ span: 1, count: 0 }, 'count', 'must be at least 1'],
    [{ span: 1, count: 10 }, 'count', 'must be less than 10'],
  ])('enforces each bound: %j', (value, path, message) => {
    expect(check(value)).toEqual([{ path, message }]);
  });

  it('refuses a value outside the enum', () => {
    expect(check({ span: 1, material: 'glass' })).toEqual([
      { path: 'material', message: 'must be one of: steel, timber' },
    ]);
  });

  it('refuses text over the declared or default length limit', () => {
    expect(check({ span: 1, label: 'abcdef' })).toEqual([{ path: 'label', message: 'must be at most 5 characters' }]);
    expect(check({ span: 1, note: 'x'.repeat(FUNCTION_CONTRACT_LIMITS.maxStringLength + 1) })).toEqual([
      { path: 'note', message: 'must be at most 2000 characters' },
    ]);
  });

  it('refuses a non-boolean for a boolean', () => {
    expect(check({ span: 1, pinned: 'yes' })).toEqual([{ path: 'pinned', message: 'must be true or false' }]);
  });

  it('enforces list length and checks each item', () => {
    expect(check({ span: 1, loads: [] })).toEqual([{ path: 'loads', message: 'must have at least 1 items' }]);
    expect(check({ span: 1, loads: [1, 2, 3, 4] })).toEqual([{ path: 'loads', message: 'must have at most 3 items' }]);
    expect(check({ span: 1, loads: [1, -2] })).toEqual([{ path: 'loads.1', message: 'must be at least 0' }]);
    expect(check({ span: 1, loads: 'none' })).toEqual([{ path: 'loads', message: 'must be a list' }]);
  });

  it('recurses into a nested object', () => {
    expect(check({ span: 1, point: {} })).toEqual([{ path: 'point.x', message: 'is required' }]);
    expect(check({ span: 1, point: { x: 'a', y: 1 } })).toEqual([
      { path: 'point.x', message: 'must be a number' },
      { path: 'point.y', message: 'is not part of the contract' },
    ]);
  });
});
