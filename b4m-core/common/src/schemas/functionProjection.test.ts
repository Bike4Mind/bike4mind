import { describe, expect, it } from 'vitest';
import {
  FUNCTION_FIELD_KEYWORDS,
  parseFunctionContract,
  type FunctionContract,
  type FunctionField,
} from './functionContract';
import { FUNCTION_LLM_KEYWORD_RULES, projectFunctionSchema, reviewHash } from './functionProjection';

// Every keyword the contract language allows, nested to the deepest level it allows.
const functionProjectionSample = () => ({
  name: 'beam_check',
  description: 'Checks a simply supported beam under a uniform load',
  inputs: {
    type: 'object',
    description: 'Beam and load',
    additionalProperties: false,
    required: ['span', 'load', 'supports'],
    properties: {
      span: { type: 'number', unit: 'm', description: 'Beam span', exclusiveMinimum: 0, maximum: 10, default: 1 },
      load: { type: 'number', unit: 'N/m', minimum: 0, exclusiveMaximum: 1000000 },
      temperature: { type: 'number', unit: 'K', minimum: 0, exclusiveMinimum: 0 },
      segments: { type: 'integer', unit: '1', enum: [1, 2, 4], default: 2 },
      material: {
        type: 'string',
        description: 'Beam material.',
        enum: ['steel', 'timber'],
        maxLength: 20,
        default: 'steel',
      },
      label: { type: 'string', maxLength: 80 },
      verbose: { type: 'boolean', default: false },
      supports: {
        type: 'array',
        minItems: 2,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position'],
          properties: {
            position: { type: 'number', unit: 'm', minimum: 0 },
            fixed: { type: 'boolean', description: 'Whether the support resists rotation' },
          },
        },
      },
      notes: { type: 'array', maxItems: 3, items: { type: 'string' } },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    properties: {
      deflection: { type: 'number', unit: 'm' },
      within_limit: { type: 'boolean' },
      reactions: { type: 'array', minItems: 2, items: { type: 'number', unit: 'N' } },
    },
  },
});

const parsed = (raw: unknown): FunctionContract => {
  const result = parseFunctionContract(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.contract;
};

const keywordsIn = (node: unknown, found = new Set<string>()): Set<string> => {
  if (typeof node !== 'object' || node === null) return found;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) found.add(key);
  if (record.items) keywordsIn(record.items, found);
  for (const child of Object.values((record.properties ?? {}) as Record<string, unknown>)) keywordsIn(child, found);
  return found;
};

const reversed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reversed(child)])
  );
};

describe('projectFunctionSchema', () => {
  const contract = parsed(functionProjectionSample());

  it('uses every keyword of the contract language in the sample', () => {
    const used = keywordsIn(contract.inputs);
    keywordsIn(contract.outputs, used);
    expect([...used].sort()).toEqual([...FUNCTION_FIELD_KEYWORDS].sort());
  });

  it('has an llm rule for every keyword of the contract language', () => {
    expect(FUNCTION_FIELD_KEYWORDS.filter(keyword => !(keyword in FUNCTION_LLM_KEYWORD_RULES))).toEqual([]);
  });

  it('renders the llm surface', () => {
    expect(projectFunctionSchema(contract, 'llm')).toMatchSnapshot();
  });

  it('renders the mcp surface', () => {
    expect(projectFunctionSchema(contract, 'mcp')).toMatchSnapshot();
  });

  it('renders the rest surface', () => {
    expect(projectFunctionSchema(contract, 'rest')).toMatchSnapshot();
  });

  it('sends the llm surface only kept keywords', () => {
    const kept = Object.keys(FUNCTION_LLM_KEYWORD_RULES).filter(key => FUNCTION_LLM_KEYWORD_RULES[key] === 'keep');
    const sent = keywordsIn(projectFunctionSchema(contract, 'llm').parameters);
    expect([...sent].filter(keyword => !kept.includes(keyword))).toEqual([]);
  });

  it('lists the units of nested outputs by path', () => {
    const nested = parsed({
      name: 'frame',
      description: 'Frame check',
      inputs: { type: 'object', additionalProperties: false, properties: {} },
      outputs: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reaction: {
            type: 'object',
            additionalProperties: false,
            properties: { left: { type: 'number', unit: 'N' }, right: { type: 'number', unit: 'N' } },
          },
          supports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { moment: { type: 'number', unit: 'N*m' } },
            },
          },
          ok: { type: 'boolean' },
        },
      },
    });
    expect(projectFunctionSchema(nested, 'llm').description).toBe(
      'Frame check\nOutputs: reaction.left (N), reaction.right (N), supports[].moment (N*m), ok.'
    );
  });

  it('keeps one [] per array level in an output path', () => {
    const grid = parsed({
      name: 'grid',
      description: 'Grid',
      inputs: { type: 'object', additionalProperties: false, properties: {} },
      outputs: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matrix: { type: 'array', items: { type: 'array', items: { type: 'number', unit: 'm' } } },
        },
      },
    });
    expect(projectFunctionSchema(grid, 'llm').description).toBe('Grid\nOutputs: matrix[] (m).');
  });

  it('renders an integer range as the whole numbers it allows', () => {
    const whole = parsed({
      name: 'pick',
      description: 'Pick',
      inputs: {
        type: 'object',
        additionalProperties: false,
        properties: { n: { type: 'integer', unit: '1', minimum: 0.5, exclusiveMaximum: 3.2 } },
      },
      outputs: { type: 'object', additionalProperties: false, properties: {} },
    });
    expect(projectFunctionSchema(whole, 'llm').parameters.properties?.n.description).toBe(
      'Unit: 1. Range: 1 <= value <= 3.'
    );
  });

  it('refuses a keyword it has no rule for', () => {
    const span = { ...contract.inputs.properties.span, pattern: '^a' } as FunctionField;
    const widened = {
      ...contract,
      inputs: { ...contract.inputs, properties: { ...contract.inputs.properties, span } },
    };
    expect(() => projectFunctionSchema(widened, 'llm')).toThrow('"pattern"');
  });
});

describe('reviewHash', () => {
  const contract = parsed(functionProjectionSample());

  it('is sha256 hex', async () => {
    expect(await reviewHash(contract)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order', async () => {
    expect(await reviewHash(reversed(contract) as FunctionContract)).toBe(await reviewHash(contract));
  });

  it.each([
    ['the name', (c: FunctionContract) => ({ ...c, name: 'beam_check_v2' })],
    ['the description', (c: FunctionContract) => ({ ...c, description: `${c.description} Revised.` })],
    [
      'an input',
      (c: FunctionContract) => ({
        ...c,
        inputs: { ...c.inputs, properties: { ...c.inputs.properties, span: { type: 'number', unit: 'mm' } } },
      }),
    ],
    [
      'an output',
      (c: FunctionContract) => ({
        ...c,
        outputs: { ...c.outputs, properties: { ...c.outputs.properties, deflection: { type: 'number', unit: 'mm' } } },
      }),
    ],
  ] as const)('changes when %s changes', async (_label, change) => {
    expect(await reviewHash(change(contract) as FunctionContract)).not.toBe(await reviewHash(contract));
  });

  it('leaves declared tests out of every projection and the hash, so editing a test needs no new review', async () => {
    const tested = parsed({
      ...functionProjectionSample(),
      tests: [
        {
          name: 'two supports',
          input: { span: 4, load: 1000, supports: [{ position: 0 }, { position: 4 }] },
          expected: { within_limit: true },
        },
      ],
    });
    expect(tested.tests).toHaveLength(1);
    for (const surface of ['llm', 'mcp', 'rest'] as const) {
      expect(JSON.stringify(projectFunctionSchema(tested, surface))).not.toContain('two supports');
    }
    expect(await reviewHash(tested)).toBe(await reviewHash(contract));
  });

  it('covers the canonical contract only, never a surface rendering or a key outside it', async () => {
    const before = await reviewHash(contract);
    for (const surface of ['llm', 'mcp', 'rest'] as const) projectFunctionSchema(contract, surface);
    expect(await reviewHash(contract)).toBe(before);
    expect(await reviewHash({ ...contract, extra: 1 } as FunctionContract)).toBe(before);
    expect(await reviewHash(projectFunctionSchema(contract, 'rest'))).toBe(before);

    const llm = projectFunctionSchema(contract, 'llm');
    const rendered = {
      ...contract,
      description: llm.description,
      inputs: llm.parameters,
    } as unknown as FunctionContract;
    expect(await reviewHash(rendered)).not.toBe(before);
  });
});
