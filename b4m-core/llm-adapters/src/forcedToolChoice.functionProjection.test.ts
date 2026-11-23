import { describe, expect, it } from 'vitest';
import { FUNCTION_FIELD_KEYWORDS, parseFunctionContract, projectFunctionSchema } from '@bike4mind/common';
import { isStrictCompatibleSchema } from './forcedToolChoice';

// Every keyword the contract language allows, nested to the deepest level it allows.
const raw = {
  name: 'beam_check',
  description: 'Checks a simply supported beam',
  inputs: {
    type: 'object',
    description: 'Beam and load',
    additionalProperties: false,
    required: ['span'],
    properties: {
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0, maximum: 10, default: 1 },
      load: { type: 'integer', unit: 'N', minimum: 0, exclusiveMaximum: 100, enum: [10, 20] },
      material: { type: 'string', enum: ['steel', 'timber'], maxLength: 20, default: 'steel' },
      verbose: { type: 'boolean', default: false },
      supports: {
        type: 'array',
        minItems: 2,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { position: { type: 'number', unit: 'm', minimum: 0 } },
        },
      },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
};

const keywordsIn = (node: unknown, found = new Set<string>()): Set<string> => {
  if (typeof node !== 'object' || node === null) return found;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) found.add(key);
  if (record.items) keywordsIn(record.items, found);
  for (const child of Object.values((record.properties ?? {}) as Record<string, unknown>)) keywordsIn(child, found);
  return found;
};

describe('the llm projection of a function contract', () => {
  const parsed = parseFunctionContract(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  const { contract } = parsed;

  it('starts from a contract that uses every keyword and is not strict-compatible as written', () => {
    expect([...keywordsIn(contract.inputs)].sort()).toEqual([...FUNCTION_FIELD_KEYWORDS].sort());
    expect(isStrictCompatibleSchema(contract.inputs)).toBe(false);
  });

  it('passes the Anthropic strict-mode check', () => {
    expect(isStrictCompatibleSchema(projectFunctionSchema(contract, 'llm').parameters)).toBe(true);
  });
});
